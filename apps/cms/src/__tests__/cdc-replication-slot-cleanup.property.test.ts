import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { type Database } from '@lumibase/database';

import { encryptSync } from '../modules/cdc/registry/encryption';
import {
  PipelineRegistry,
  type ConnectivityChecker,
  type ConnectorResolver,
  type CdcConnectorType,
} from '../modules/cdc/registry/pipeline-registry';
import {
  DebeziumKafkaConnector,
  type ReplicationSlotManager,
} from '../modules/cdc/connectors/debezium-kafka';
import {
  MaterializedEngineConnector,
  type PgSchemaReader,
  type PgTableSchema,
} from '../modules/cdc/connectors/materialized-engine';
import type {
  CdcConnector,
  ConnectorConfig,
  ProvisionResult,
} from '../modules/cdc/connectors/types';

/**
 * Feature: clickhouse-cdc, Property 22: Replication slot cleanup on deletion
 *
 * For any replication-slot-based pipeline (Debezium+Kafka or Materialized
 * Engine) that is deleted, no PostgreSQL replication slot associated with that
 * pipeline SHALL remain on the Source_Database after the delete operation
 * completes.
 *
 * The Source_Database's set of replication slots is modelled by an in-memory
 * {@link ReplicationSlotManager} test double (a `Set` of slot names). The real
 * connector instances (`DebeziumKafkaConnector` / `MaterializedEngineConnector`)
 * are wired to this slot manager, provisioned (which registers the pipeline's
 * slot on the Source_Database), and then deleted through the real
 * {@link PipelineRegistry.delete}. The registry resolves the connector via an
 * injected `connectorResolver` and calls `connector.destroy(pipelineId)` —
 * which drops the slot via `pg_drop_replication_slot` — BEFORE removing the
 * registry record.
 *
 * **Validates: Requirements 1.8**
 */

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!';
const SOURCE_CONNECTION = 'postgresql://user:pass@localhost:5432/db';
const SINK_CONNECTION = 'clickhouse://user:pass@localhost:8123/db';

/** A connectivity checker that always succeeds (Req 1.5 is out of scope here). */
const alwaysReachable: ConnectivityChecker = async () => {};

// ── In-memory Source_Database replication-slot manager ─────────────────────
//
// Models the set of PostgreSQL replication slots that exist on the
// Source_Database. `createSlot` simulates provisioning registering a slot;
// `dropSlot` (the production interface method, invoked by a connector's
// destroy() via pg_drop_replication_slot) removes it. Idempotent on both ends.

class InMemoryReplicationSlotManager implements ReplicationSlotManager {
  readonly slots = new Set<string>();

  /** Simulate the slot being created on the Source_Database at provision time. */
  createSlot(slotName: string): void {
    this.slots.add(slotName);
  }

  /** Drop a slot (pg_drop_replication_slot). Idempotent. */
  async dropSlot(slotName: string, _sourceConnection: string): Promise<void> {
    this.slots.delete(slotName);
  }

  has(slotName: string): boolean {
    return this.slots.has(slotName);
  }
}

/**
 * Stub PostgreSQL schema reader for the Materialized Engine connector so
 * provisioning never touches a live database. Returns an empty column list —
 * Property 22 only cares about slot lifecycle, not schema mapping.
 */
const stubSchemaReader: PgSchemaReader = {
  async readTableSchema(_sourceConnection, table): Promise<PgTableSchema> {
    return { table, columns: [] };
  },
};

// ── Minimal fake Database for the registry delete flow ─────────────────────
//
// `PipelineRegistry.delete` performs (1) a `select … where … limit 1` to
// resolve the pipeline and confirm site ownership, then (2) a
// `delete … returning({ id })`. This fake faithfully serves the single
// provisioned pipeline row for the resolve step and removes it on delete.

function makePipelineRow(
  pipelineId: string,
  siteId: string,
  connectorType: CdcConnectorType,
): Record<string, unknown> {
  const now = new Date();
  return {
    id: pipelineId,
    siteId,
    pipelineName: `pipeline-${pipelineId}`,
    connectorType,
    status: 'active',
    statusMessage: null,
    sourceConnection: encryptSync(SOURCE_CONNECTION, TEST_ENCRYPTION_KEY),
    sinkConnection: encryptSync(SINK_CONNECTION, TEST_ENCRYPTION_KEY),
    intermediaryConnection: null,
    replicationTables: ['users'],
    config: {},
    lastSyncAt: null,
    lastSyncRecordCount: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createFakeDb(row: Record<string, unknown>): Database {
  let deleted = false;
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(deleted ? [] : [row]);
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          return {
            returning() {
              if (deleted) return Promise.resolve([]);
              deleted = true;
              return Promise.resolve([{ id: row.id }]);
            },
          };
        },
      };
    },
  };
  return db as unknown as Database;
}

// ── Connector construction (real instances) ────────────────────────────────

type SlotBasedConnectorType = 'debezium_kafka' | 'materialized_engine';

function makeConnector(
  type: SlotBasedConnectorType,
  slotManager: InMemoryReplicationSlotManager,
): CdcConnector {
  if (type === 'debezium_kafka') {
    return new DebeziumKafkaConnector({ slotManager });
  }
  return new MaterializedEngineConnector({
    slotManager,
    schemaReader: stubSchemaReader,
  });
}

// ── Arbitraries ────────────────────────────────────────────────────────────

const arbSlotBasedConnectorType: fc.Arbitrary<SlotBasedConnectorType> =
  fc.constantFrom('debezium_kafka', 'materialized_engine');

const arbPipelineId = fc
  .stringMatching(/^[A-Za-z0-9_-]{1,21}$/)
  .filter((s) => s.length >= 1);

const arbSiteId = fc
  .stringMatching(/^[A-Za-z0-9_-]{1,16}$/)
  .filter((s) => s.length >= 1);

const arbTables = fc.uniqueArray(
  fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
  { minLength: 1, maxLength: 5 },
);

/** Foreign slots belonging to OTHER pipelines — must survive the deletion. */
const arbForeignSlots = fc.uniqueArray(
  fc.stringMatching(/^external_[a-z0-9_]{1,20}$/),
  { minLength: 0, maxLength: 5 },
);

// ── Property 22 ─────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 22: Replication slot cleanup on deletion', () => {
  it('leaves no replication slot associated with a deleted slot-based pipeline on the Source_Database', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSlotBasedConnectorType,
        arbPipelineId,
        arbSiteId,
        arbTables,
        arbForeignSlots,
        async (connectorType, pipelineId, siteId, tables, foreignSlots) => {
          // The Source_Database's replication-slot set, shared by the
          // connector (drops on destroy) and the test harness (seeds slots).
          const slotManager = new InMemoryReplicationSlotManager();

          // Seed unrelated slots from other pipelines.
          for (const slot of foreignSlots) {
            slotManager.createSlot(slot);
          }

          const connector = makeConnector(connectorType, slotManager);

          // 1. Provision the pipeline. The connector reports the replication
          //    slot(s) it created; simulate them existing on the source.
          const config: ConnectorConfig = {
            pipelineId,
            tenantId: siteId,
            sourceConnection: SOURCE_CONNECTION,
            sinkConnection: SINK_CONNECTION,
            replicationTables: tables,
          };
          const result: ProvisionResult = await connector.provision(config);
          expect(result.success).toBe(true);

          const slotResources = result.provisionedResources.filter(
            (r) => r.type === 'replication_slot',
          );
          // A slot-based approach must have provisioned at least one slot.
          expect(slotResources.length).toBeGreaterThan(0);
          const pipelineSlotNames = slotResources.map((r) => r.id);
          for (const slotName of pipelineSlotNames) {
            slotManager.createSlot(slotName);
            expect(slotManager.has(slotName)).toBe(true);
          }

          // 2. Delete through the real registry, which resolves the connector
          //    and calls destroy() (slot cleanup) before removing the record.
          const row = makePipelineRow(pipelineId, siteId, connectorType);
          const resolver: ConnectorResolver = (type) =>
            type === connector.type ? connector : null;
          const registry = new PipelineRegistry({
            db: createFakeDb(row),
            encryptionKey: TEST_ENCRYPTION_KEY,
            connectivityChecker: alwaysReachable,
            connectorResolver: resolver,
          });

          await registry.delete(siteId, pipelineId);

          // 3. No replication slot associated with the deleted pipeline
          //    remains on the Source_Database (Property 22 / Req 1.8).
          for (const slotName of pipelineSlotNames) {
            expect(slotManager.has(slotName)).toBe(false);
          }

          // Unrelated slots are untouched — cleanup is scoped to the pipeline.
          for (const slot of foreignSlots) {
            expect(slotManager.has(slot)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
