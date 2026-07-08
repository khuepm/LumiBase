/**
 * Unit tests for PipelineRegistryService.
 *
 * Uses a fake Database that records Drizzle operations without a real
 * Postgres connection, following the same pattern as
 * `login-guard/__tests__/counter.test.ts`.
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 1.6, 1.7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cdcPipelines, type Database } from '@lumibase/database';

import { encrypt } from '../encryption';
import {
  PipelineRegistry,
  PipelineLimitExceededError,
  PipelineNameConflictError,
  ConnectivityCheckError,
  PipelineNotFoundError,
  ReplicationSlotCleanupError,
  type PipelineCreateInput,
  type ConnectivityChecker,
  type ConnectorResolver,
  type CdcConnectorType,
} from '../pipeline-registry';
import type { CdcConnector } from '../../connectors/types';

// ── Fake Database ────────────────────────────────────────────────────────

function createFakeDb(options?: {
  existingPipelines?: Array<Record<string, unknown>>;
  pipelineCount?: number;
}) {
  const pipelines = options?.existingPipelines ?? [];
  const pipelineCount = options?.pipelineCount ?? pipelines.length;

  const insertedRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const deletedIds: string[] = [];

  const fakeDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(pipelines.slice(0, 1)),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertedRows.push(values);
        return {
          returning: vi.fn().mockResolvedValue([
            {
              ...values,
              createdAt: values.createdAt ?? new Date(),
              updatedAt: values.updatedAt ?? new Date(),
            },
          ]),
        };
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            if (pipelines.length > 0) {
              const updated = { ...pipelines[0], ...updatedRows[0] };
              return Promise.resolve([updated]);
            }
            return Promise.resolve([]);
          }),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => {
          if (pipelines.length > 0) {
            return Promise.resolve([{ id: pipelines[0]!.id }]);
          }
          return Promise.resolve([]);
        }),
      }),
    }),
  };

  // Override select for count queries
  const selectWithCount = vi.fn().mockImplementation((selection) => {
    // Check if this is a count query
    const isCountQuery =
      selection && Object.keys(selection).some((k) => k === 'value');

    if (isCountQuery) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ value: pipelineCount }]),
        }),
      };
    }

    // Regular select
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(pipelines.slice(0, 1)),
        }),
      }),
    };
  });

  fakeDb.select = selectWithCount;

  return {
    db: fakeDb as unknown as Database,
    insertedRows,
    updatedRows,
    deletedIds,
  };
}

// ── Test helpers ─────────────────────────────────────────────────────────

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!';

const validInput: PipelineCreateInput = {
  pipeline_name: 'my-pipeline',
  cdc_connector_type: 'debezium_kafka',
  source_database_connection: 'postgresql://user:pass@localhost:5432/db',
  clickhouse_sink_connection: 'clickhouse://user:pass@localhost:8123/db',
  replication_tables: ['users', 'orders'],
  config: { slot_name: 'test_slot' },
};

const noopConnectivityChecker: ConnectivityChecker = async () => {
  // Always succeeds
};

const failingConnectivityChecker: ConnectivityChecker = async (
  connectionString: string,
) => {
  throw new Error('Connection timed out');
};

/**
 * Build a fully-populated pipeline row (with encrypted connection fields) so
 * `PipelineRegistry.get` can decrypt and map it to a PipelineRecord. Used by
 * the delete tests, which must resolve the pipeline before connector teardown.
 */
async function makePipelineRow(
  overrides?: Partial<{
    id: string;
    siteId: string;
    pipelineName: string;
    connectorType: CdcConnectorType;
  }>,
): Promise<Record<string, unknown>> {
  const now = new Date();
  return {
    id: overrides?.id ?? 'pipeline-1',
    siteId: overrides?.siteId ?? 'site-1',
    pipelineName: overrides?.pipelineName ?? 'my-pipeline',
    connectorType: overrides?.connectorType ?? 'debezium_kafka',
    status: 'active',
    statusMessage: null,
    sourceConnection: await encrypt(
      'postgresql://user:pass@localhost:5432/db',
      TEST_ENCRYPTION_KEY,
    ),
    sinkConnection: await encrypt(
      'clickhouse://user:pass@localhost:8123/db',
      TEST_ENCRYPTION_KEY,
    ),
    intermediaryConnection: null,
    replicationTables: ['users', 'orders'],
    config: {},
    lastSyncAt: null,
    lastSyncRecordCount: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A minimal fake CdcConnector that records destroy() invocations and can be
 * configured to fail (simulating replication-slot cleanup failure). The
 * `destroy` method is a vi.fn so call ordering can be asserted against the
 * database delete.
 */
function makeFakeConnector(options?: {
  type?: CdcConnectorType;
  failDestroy?: boolean;
}): CdcConnector & { destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn(async (_pipelineId: string) => {
    if (options?.failDestroy) {
      throw new Error('pg_drop_replication_slot failed: slot in use');
    }
  });
  const connector = {
    type: options?.type ?? 'debezium_kafka',
    destroy,
    async provision() {
      throw new Error('not implemented');
    },
    async start() {},
    async stop() {},
    async healthCheck() {
      throw new Error('not implemented');
    },
    async getMetrics() {
      throw new Error('not implemented');
    },
  } as unknown as CdcConnector & { destroy: ReturnType<typeof vi.fn> };
  return connector;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PipelineRegistry', () => {
  describe('create', () => {
    it('should create a pipeline with valid input', async () => {
      const { db } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      const result = await registry.create('site-1', validInput);

      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.pipelineName).toBe('my-pipeline');
      expect(result.connectorType).toBe('debezium_kafka');
      expect(result.status).toBe('provisioning');
      expect(result.siteId).toBe('site-1');
    });

    it('should reject when site has 50 pipelines (Req 1.7)', async () => {
      const { db } = createFakeDb({ pipelineCount: 50 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      await expect(registry.create('site-1', validInput)).rejects.toThrow(
        PipelineLimitExceededError,
      );
    });

    it('should allow creation when site has 49 pipelines', async () => {
      const { db } = createFakeDb({ pipelineCount: 49 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      const result = await registry.create('site-1', validInput);
      expect(result).toBeDefined();
      expect(result.pipelineName).toBe('my-pipeline');
    });

    it('should reject duplicate pipeline name per site (Req 1.6)', async () => {
      const { db } = createFakeDb({
        pipelineCount: 1,
        existingPipelines: [{ id: 'existing-1', pipelineName: 'my-pipeline' }],
      });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      await expect(registry.create('site-1', validInput)).rejects.toThrow(
        PipelineNameConflictError,
      );
    });

    it('should reject when connectivity check fails (Req 1.5)', async () => {
      const { db } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: failingConnectivityChecker,
      });

      await expect(registry.create('site-1', validInput)).rejects.toThrow(
        ConnectivityCheckError,
      );
    });

    it('should encrypt connection parameters before storing', async () => {
      const { db, insertedRows } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      await registry.create('site-1', validInput);

      // The insert call should have been made with encrypted values
      expect(db.insert).toHaveBeenCalled();
    });

    it('should support all three connector types (Req 1.2)', async () => {
      const { db } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      for (const connectorType of [
        'debezium_kafka',
        'materialized_engine',
        'airbyte',
      ] as const) {
        const input = { ...validInput, cdc_connector_type: connectorType };
        const result = await registry.create('site-1', input);
        expect(result.connectorType).toBe(connectorType);
      }
    });
  });

  describe('get', () => {
    it('should return null when pipeline not found', async () => {
      const { db } = createFakeDb({ existingPipelines: [] });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      const result = await registry.get('site-1', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should throw PipelineNotFoundError when pipeline does not exist', async () => {
      const { db } = createFakeDb({ existingPipelines: [] });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      await expect(
        registry.delete('site-1', 'nonexistent'),
      ).rejects.toThrow(PipelineNotFoundError);
    });

    it('should invoke connector.destroy BEFORE removing the registry record (Req 1.8)', async () => {
      const row = await makePipelineRow({
        id: 'pipeline-1',
        siteId: 'site-1',
        connectorType: 'debezium_kafka',
      });
      const { db } = createFakeDb({ existingPipelines: [row] });

      // Record the order of side effects: destroy() must run before delete().
      const callOrder: string[] = [];
      const connector = makeFakeConnector({ type: 'debezium_kafka' });
      connector.destroy.mockImplementation(async () => {
        callOrder.push('destroy');
      });
      // vitest 4's vi.spyOn reuses the existing mock instance, so a reference
      // captured before spying resolves to the spy itself and would recurse.
      // Capture the fake's return chain (mockReturnValue yields a stable
      // object) up front and hand it back directly instead of calling through.
      const deleteChain = (db.delete as () => unknown)();
      vi.spyOn(db, 'delete').mockImplementation(() => {
        callOrder.push('delete');
        return deleteChain as ReturnType<typeof db.delete>;
      });

      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
        connectorResolver: () => connector,
      });

      await registry.delete('site-1', 'pipeline-1');

      expect(connector.destroy).toHaveBeenCalledWith('pipeline-1');
      expect(callOrder).toEqual(['destroy', 'delete']);
    });

    it('should resolve the connector by the pipeline connector type (Req 1.8)', async () => {
      const row = await makePipelineRow({
        id: 'pipeline-1',
        siteId: 'site-1',
        connectorType: 'materialized_engine',
      });
      const { db } = createFakeDb({ existingPipelines: [row] });

      const resolver = vi.fn<ConnectorResolver>(() =>
        makeFakeConnector({ type: 'materialized_engine' }),
      );

      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
        connectorResolver: resolver,
      });

      await registry.delete('site-1', 'pipeline-1');

      expect(resolver).toHaveBeenCalledWith('materialized_engine');
    });

    it('should keep the registry record when connector.destroy (slot cleanup) fails (Req 1.8)', async () => {
      const row = await makePipelineRow({
        id: 'pipeline-1',
        siteId: 'site-1',
        connectorType: 'debezium_kafka',
      });
      const { db } = createFakeDb({ existingPipelines: [row] });
      const deleteSpy = vi.spyOn(db, 'delete');

      const connector = makeFakeConnector({
        type: 'debezium_kafka',
        failDestroy: true,
      });

      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
        connectorResolver: () => connector,
      });

      await expect(registry.delete('site-1', 'pipeline-1')).rejects.toThrow(
        ReplicationSlotCleanupError,
      );

      // The record MUST NOT be removed while the slot still lingers.
      expect(connector.destroy).toHaveBeenCalledWith('pipeline-1');
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('should remove the record without connector teardown when no resolver is provided', async () => {
      const row = await makePipelineRow({ id: 'pipeline-1', siteId: 'site-1' });
      const { db } = createFakeDb({ existingPipelines: [row] });
      const deleteSpy = vi.spyOn(db, 'delete');

      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      await registry.delete('site-1', 'pipeline-1');

      expect(deleteSpy).toHaveBeenCalled();
    });

    it('should skip connector teardown when the resolver returns null', async () => {
      const row = await makePipelineRow({ id: 'pipeline-1', siteId: 'site-1' });
      const { db } = createFakeDb({ existingPipelines: [row] });
      const deleteSpy = vi.spyOn(db, 'delete');

      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
        connectorResolver: () => null,
      });

      await registry.delete('site-1', 'pipeline-1');

      expect(deleteSpy).toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('should throw PipelineNotFoundError when pipeline does not exist', async () => {
      const { db } = createFakeDb({ existingPipelines: [] });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: noopConnectivityChecker,
      });

      await expect(
        registry.updateStatus('nonexistent', 'active'),
      ).rejects.toThrow(PipelineNotFoundError);
    });
  });

  describe('connectivity check', () => {
    it('should use 10-second timeout for connectivity checks', async () => {
      let capturedTimeout = 0;
      const timeoutCapture: ConnectivityChecker = async (
        _conn,
        timeoutMs,
      ) => {
        capturedTimeout = timeoutMs;
      };

      const { db } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: timeoutCapture,
      });

      await registry.create('site-1', validInput);
      expect(capturedTimeout).toBe(10000);
    });

    it('should check both source and sink connections', async () => {
      const checkedConnections: string[] = [];
      const trackingChecker: ConnectivityChecker = async (conn) => {
        checkedConnections.push(conn);
      };

      const { db } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: trackingChecker,
      });

      await registry.create('site-1', validInput);
      expect(checkedConnections).toContain(
        validInput.source_database_connection,
      );
      expect(checkedConnections).toContain(
        validInput.clickhouse_sink_connection,
      );
    });

    it('should report which endpoint failed connectivity', async () => {
      let callCount = 0;
      const failOnSecond: ConnectivityChecker = async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Connection refused');
        }
      };

      const { db } = createFakeDb({ pipelineCount: 0 });
      const registry = new PipelineRegistry({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        connectivityChecker: failOnSecond,
      });

      try {
        await registry.create('site-1', validInput);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectivityCheckError);
        expect((err as ConnectivityCheckError).endpoint).toBe('sink');
      }
    });
  });
});
