import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  Column,
  getTableColumns,
  getTableName,
  type SQL,
} from 'drizzle-orm';
import { cdcPipelines, type Database } from '@lumibase/database';

import {
  encryptSync,
  decryptSync,
  encrypt,
  decrypt,
} from '../modules/cdc/registry/encryption';
import {
  PipelineRegistry,
  PipelineNameConflictError,
  type ConnectivityChecker,
  type CdcConnectorType,
  type PipelineCreateInput,
} from '../modules/cdc/registry/pipeline-registry';

/**
 * Feature: clickhouse-cdc, Property 3: Connection parameter encryption round-trip
 *
 * For any connection string stored in the Pipeline Registry, encrypting then
 * decrypting SHALL produce the original string, and the encrypted stored value
 * SHALL not equal the plaintext input.
 *
 * The Pipeline Registry stores connection parameters using the synchronous
 * `encryptSync`/`decryptSync` pair, so those are the primary subject of this
 * property; the asynchronous Web Crypto `encrypt`/`decrypt` pair is exercised
 * under the same property for completeness.
 *
 * **Validates: Requirements 1.4**
 */

/**
 * Feature: clickhouse-cdc, Property 4: Pipeline name uniqueness per site
 *
 * For any pipeline name and site (identified by site_id), if a pipeline with
 * that name already exists for that site, a second registration attempt with
 * the same name SHALL be rejected with a duplicate error. Uniqueness is scoped
 * per site: the same name registered under a different site_id is allowed.
 *
 * **Validates: Requirements 1.6**
 */

// ── Arbitraries ───────────────────────────────────────────────────────────

/**
 * Generates an arbitrary connection string. Mixes free-form unicode strings
 * (the "for any" obligation) with realistically-shaped DSN values so the
 * round-trip is exercised across both adversarial and representative inputs.
 */
const arbConnectionString = fc.oneof(
  fc.string({ minLength: 0, maxLength: 512 }),
  fc
    .record({
      scheme: fc.constantFrom('postgresql', 'postgres', 'clickhouse'),
      user: fc.string({ minLength: 1, maxLength: 24 }),
      pass: fc.string({ minLength: 1, maxLength: 32 }),
      host: fc.domain(),
      port: fc.integer({ min: 1, max: 65535 }),
      db: fc.string({ minLength: 1, maxLength: 24 }),
    })
    .map(
      ({ scheme, user, pass, host, port, db }) =>
        `${scheme}://${user}:${pass}@${host}:${port}/${db}`,
    ),
);

/** Generates a non-empty encryption key. */
const arbEncryptionKey = fc.string({ minLength: 1, maxLength: 64 });

/** Generates a valid pipeline name (1–128 non-empty characters). */
const arbPipelineName = fc
  .string({ minLength: 1, maxLength: 128 })
  .filter((s) => s.trim().length > 0);

/** Generates a non-empty site identifier. */
const arbSiteId = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s.trim().length > 0);

const arbConnectorType: fc.Arbitrary<CdcConnectorType> = fc.constantFrom(
  'debezium_kafka',
  'materialized_engine',
  'airbyte',
);

/** Builds a complete, valid pipeline create input given a name. */
function makeCreateInput(name: string): fc.Arbitrary<PipelineCreateInput> {
  return fc.record({
    pipeline_name: fc.constant(name),
    cdc_connector_type: arbConnectorType,
    source_database_connection: fc.constant('postgresql://u:p@localhost:5432/db'),
    clickhouse_sink_connection: fc.constant('clickhouse://u:p@localhost:8123/db'),
    replication_tables: fc.array(
      fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.length >= 1),
      { minLength: 1, maxLength: 5 },
    ),
  });
}

// ── In-memory fake Database ────────────────────────────────────────────────
//
// No DATABASE_URL is available in the unit-test environment (the repo's
// integration tests skip without one), so Property 4 exercises the REAL
// `PipelineRegistry.create` against a minimal in-memory stand-in for the
// Postgres storage layer. The fake faithfully implements the equality-filter
// semantics the registry relies on (eq / and-of-eq WHERE clauses, count(),
// column projection, and insert().returning()) by interpreting Drizzle's SQL
// condition objects. The logic under test — the registry's per-site uniqueness
// enforcement — is the production code path, not a reimplementation.

type Row = Record<string, unknown>;

interface EqConstraint {
  dbName: string;
  value: unknown;
}

/** Recursively collect `column = value` equality constraints from a SQL condition. */
function isColumn(val: unknown): val is Column {
  return !!(
    val &&
    typeof val === 'object' &&
    'name' in val &&
    'table' in val &&
    typeof (val as { name: unknown }).name === 'string'
  );
}

function isParam(val: unknown): boolean {
  return !!(
    val &&
    typeof val === 'object' &&
    ('encoder' in val || val.constructor?.name === 'Param')
  );
}

/** Recursively collect `column = value` equality constraints from a SQL condition. */
function extractEqConstraints(condition: SQL | undefined): EqConstraint[] {
  const out: EqConstraint[] = [];
  if (!condition) return out;
  let pendingCol: Column | null = null;

  const visit = (node: unknown): void => {
    if (node && typeof node === 'object' && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
      for (const ch of (node as { queryChunks: unknown[] }).queryChunks) visit(ch);
      return;
    }
    if (isColumn(node)) {
      pendingCol = node;
      return;
    }
    if (isParam(node)) {
      if (pendingCol) {
        out.push({ dbName: pendingCol.name, value: (node as { value: unknown }).value });
        pendingCol = null;
      }
      return;
    }
    // StringChunk / operators / anything else → ignored.
  };

  visit(condition);
  return out;
}

class FakeDatabase {
  private readonly store = new Map<string, Row[]>();

  private rowsFor(table: unknown): Row[] {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    let rows = this.store.get(name);
    if (!rows) {
      rows = [];
      this.store.set(name, rows);
    }
    return rows;
  }

  private dbToJs(table: unknown): Record<string, string> {
    const cols = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
    const map: Record<string, string> = {};
    for (const [jsKey, col] of Object.entries(cols)) {
      map[(col as Column).name] = jsKey;
    }
    return map;
  }

  private filter(table: unknown, condition: SQL | undefined): Row[] {
    const rows = this.rowsFor(table);
    if (!condition) return [...rows];
    const constraints = extractEqConstraints(condition);
    const map = this.dbToJs(table);
    return rows.filter((row) =>
      constraints.every((c) => {
        const jsKey = map[c.dbName] ?? c.dbName;
        return row[jsKey] === c.value;
      }),
    );
  }

  select(projection?: Record<string, unknown>) {
    const self = this;
    let table: unknown;
    let condition: SQL | undefined;
    const builder = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      where(c: SQL) {
        condition = c;
        return builder;
      },
      limit(n: number) {
        return Promise.resolve(self.runSelect(table, condition, projection).slice(0, n));
      },
      then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(self.runSelect(table, condition, projection)).then(
          resolve,
          reject,
        );
      },
    };
    return builder;
  }

  private runSelect(
    table: unknown,
    condition: SQL | undefined,
    projection?: Record<string, unknown>,
  ): Row[] {
    const matched = this.filter(table, condition);
    if (!projection) return matched.map((r) => ({ ...r }));

    // A count() aggregate collapses all matched rows into a single count row.
    if (this.isCountProjection(projection)) {
      return [this.projectCount(projection, matched)];
    }
    return matched.map((row) => this.projectColumns(projection, row, table));
  }

  private isCountProjection(projection: Record<string, unknown>): boolean {
    // count() is an SQL aggregate (not a Column instance).
    return Object.values(projection).some((v) => !isColumn(v));
  }

  private projectCount(projection: Record<string, unknown>, matched: Row[]): Row {
    const out: Row = {};
    for (const key of Object.keys(projection)) {
      out[key] = matched.length;
    }
    return out;
  }

  private projectColumns(
    projection: Record<string, unknown>,
    row: Row,
    table: unknown,
  ): Row {
    const map = this.dbToJs(table);
    const out: Row = {};
    for (const [key, val] of Object.entries(projection)) {
      if (isColumn(val)) {
        const jsKey = map[val.name] ?? val.name;
        out[key] = row[jsKey];
      }
    }
    return out;
  }

  insert(table: unknown) {
    const self = this;
    return {
      values(value: Row | Row[]) {
        const toInsert = Array.isArray(value) ? value : [value];
        const rows = self.rowsFor(table);
        const stored = toInsert.map((v) => ({ ...v }));
        for (const r of stored) rows.push(r);
        return {
          returning() {
            return Promise.resolve(stored.map((r) => ({ ...r })));
          },
        };
      },
    };
  }
}

/** A connectivity checker that always succeeds (Req 1.5 is out of scope here). */
const alwaysReachable: ConnectivityChecker = async () => {};

function makeRegistry(): PipelineRegistry {
  return new PipelineRegistry({
    db: new FakeDatabase() as unknown as Database,
    encryptionKey: 'test-encryption-key',
    connectivityChecker: alwaysReachable,
  });
}

// ── Property 3 ─────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 3: Connection parameter encryption round-trip', () => {
  it('encryptSync then decryptSync reproduces the original connection string', () => {
    fc.assert(
      fc.property(arbConnectionString, arbEncryptionKey, (plaintext, key) => {
        const encrypted = encryptSync(plaintext, key);
        const decrypted = decryptSync(encrypted, key);
        expect(decrypted).toBe(plaintext);
      }),
      { numRuns: 100 },
    );
  });

  it('the encryptSync stored value never equals the plaintext input', () => {
    fc.assert(
      fc.property(arbConnectionString, arbEncryptionKey, (plaintext, key) => {
        const encrypted = encryptSync(plaintext, key);
        expect(encrypted).not.toBe(plaintext);
      }),
      { numRuns: 100 },
    );
  });

  it('async encrypt then decrypt reproduces the original, and encrypted ≠ plaintext', async () => {
    await fc.assert(
      fc.asyncProperty(arbConnectionString, arbEncryptionKey, async (plaintext, key) => {
        const encrypted = await encrypt(plaintext, key);
        expect(encrypted).not.toBe(plaintext);
        const decrypted = await decrypt(encrypted, key);
        expect(decrypted).toBe(plaintext);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 4 ─────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 4: Pipeline name uniqueness per site', () => {
  it('a second registration with an existing name in the same site is rejected with a duplicate error', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSiteId,
        arbPipelineName.chain((name) =>
          fc.tuple(makeCreateInput(name), makeCreateInput(name)),
        ),
        async (siteId, [firstInput, secondInput]) => {
          const registry = makeRegistry();

          // First registration succeeds.
          const created = await registry.create(siteId, firstInput);
          expect(created.pipelineName).toBe(firstInput.pipeline_name);

          // Second registration with the same name + same site is rejected.
          await expect(registry.create(siteId, secondInput)).rejects.toBeInstanceOf(
            PipelineNameConflictError,
          );
          await expect(registry.create(siteId, secondInput)).rejects.toMatchObject({
            code: 'PIPELINE_NAME_CONFLICT',
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the same pipeline name is allowed under a different site (uniqueness is per site)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(arbSiteId, arbSiteId)
          .filter(([a, b]) => a !== b),
        arbPipelineName.chain((name) =>
          fc.tuple(makeCreateInput(name), makeCreateInput(name)),
        ),
        async ([siteA, siteB], [inputA, inputB]) => {
          const registry = makeRegistry();

          const a = await registry.create(siteA, inputA);
          const b = await registry.create(siteB, inputB);

          expect(a.pipelineName).toBe(b.pipelineName);
          expect(a.siteId).toBe(siteA);
          expect(b.siteId).toBe(siteB);
        },
      ),
      { numRuns: 100 },
    );
  });
});
