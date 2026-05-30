import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { auditLog, loginAttempts } from '@lumibase/database';

import { AuditRotator } from '../rotator';
import { buildAuditRotator, runScheduledRotation } from '../scheduled';

/**
 * Unit tests for the shared scheduled-rotation glue
 * (admin-setup-wizard task 11.4; Req 15.5; design §10.2).
 *
 * This module is the convergence point both runtime entrypoints call:
 * `serve.ts` (node-cron tick) and `cloudflare.ts` (Cron Trigger
 * `scheduled` handler). It runs WITHOUT Postgres by reusing the same
 * hand-rolled fake Drizzle client shape as `rotator.test.ts`: each
 * `delete(table)…returning()` records the table and returns a
 * configurable row array.
 *
 * Coverage:
 *   - buildAuditRotator returns an AuditRotator bound to the given db.
 *   - runScheduledRotation drives rotate() (both DELETEs) and reports
 *     the summed pruned count via the injected logger.
 *   - runScheduledRotation never rejects and logs the count even when a
 *     table prune fails best-effort (partial count).
 *
 * **Validates: Requirements 15.5**
 */

const AUDIT_LOG_TABLE = getTableName(auditLog);
const LOGIN_ATTEMPTS_TABLE = getTableName(loginAttempts);

interface FakeDbOptions {
  readonly deletedByTable?: Record<string, number>;
  readonly rejectDeleteByTable?: Record<string, Error>;
}

function makeFakeDb(opts: FakeDbOptions = {}) {
  const deletes: string[] = [];
  const db = {
    delete(table: unknown) {
      const name = getTableName(table as never);
      return {
        where() {
          return {
            returning() {
              deletes.push(name);
              const reject = opts.rejectDeleteByTable?.[name];
              if (reject) return Promise.reject(reject);
              const n = opts.deletedByTable?.[name] ?? 0;
              return Promise.resolve(
                Array.from({ length: n }, (_v, i) => ({ id: `${name}-${i}` })),
              );
            },
          };
        },
      };
    },
  };
  return { db: db as never, deletes };
}

function makeLogger() {
  return { log: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildAuditRotator (task 11.4)', () => {
  it('returns an AuditRotator instance bound to the db', () => {
    const { db } = makeFakeDb();
    const rotator = buildAuditRotator(db);
    expect(rotator).toBeInstanceOf(AuditRotator);
  });
});

describe('runScheduledRotation (Req 15.5, design §10.2)', () => {
  it('prunes both tables and logs the summed deleted count', async () => {
    const { db, deletes } = makeFakeDb({
      deletedByTable: {
        [AUDIT_LOG_TABLE]: 3,
        [LOGIN_ATTEMPTS_TABLE]: 5,
      },
    });
    const logger = makeLogger();

    const result = await runScheduledRotation(db, logger);

    expect(result).toEqual({ deleted: 8 });
    expect(deletes).toEqual([AUDIT_LOG_TABLE, LOGIN_ATTEMPTS_TABLE]);
    expect(logger.log).toHaveBeenCalledWith(
      '[lumibase-cms] audit rotation pruned 8 rows',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('never rejects and logs the partial count when a table prune fails', async () => {
    // Silence rotate()'s internal best-effort console.warn.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = makeFakeDb({
      rejectDeleteByTable: {
        [AUDIT_LOG_TABLE]: new Error('lock timeout'),
      },
      deletedByTable: {
        [LOGIN_ATTEMPTS_TABLE]: 4,
      },
    });
    const logger = makeLogger();

    const result = await runScheduledRotation(db, logger);

    expect(result).toEqual({ deleted: 4 });
    expect(logger.log).toHaveBeenCalledWith(
      '[lumibase-cms] audit rotation pruned 4 rows',
    );
  });
});
