import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { auditLog, loginAttempts } from '@lumibase/database';

import {
  AuditRotator,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  HIGH_COUNT_THRESHOLD,
  ROTATE_THROTTLE_MS,
} from '../rotator';

/**
 * Unit tests for the AuditRotator retention pruner + the
 * `resolveRetentionDays` clamp (admin-setup-wizard task 11.3).
 *
 * These run WITHOUT Postgres: a hand-rolled fake Drizzle client
 * (mirroring the `makeFakeDb` capture pattern from
 * `audit/__tests__/logger.test.ts`) records each `delete(table)…
 * .returning()` call and returns a per-table configurable array, and
 * answers `select({ count }).from(audit_log)` with a configurable
 * number. The throttle is driven by an injected `now()` clock so the
 * 1-hour window is exercised deterministically without fake timers.
 *
 * Coverage:
 *   - resolveRetentionDays: default 90 for undefined/empty/non-numeric;
 *     1 (min) and 3650 (max) valid; 0 and 5000 (out of range) → 90;
 *     '30' → 30; 'abc' → 90; floats → 90.
 *   - rotate: issues both DELETEs with the right cutoff, returns the
 *     summed deleted count; a failing first delete still attempts the
 *     second (best-effort, partial count); returns { deleted: 0 } when
 *     nothing matched.
 *   - maybeRotateOnHighCount: count ≤ 10000 → { rotated: false } (no
 *     delete); count > 10000 → rotates; a second call within the hour →
 *     throttled; after advancing now ≥ 1h → rotates again.
 *
 * **Validates: Requirements 15.5**
 */

const AUDIT_LOG_TABLE = getTableName(auditLog);
const LOGIN_ATTEMPTS_TABLE = getTableName(loginAttempts);

// ── fake Drizzle client ─────────────────────────────────────────────────

interface DeleteCapture {
  /** Resolved table name for the DELETE. */
  readonly table: string;
  /** The where-clause fragment passed to `.where(...)`. */
  readonly where: unknown;
  /** The projection passed to `.returning(...)`. */
  readonly returning: unknown;
}

interface FakeDbOptions {
  /**
   * Number of rows each table's DELETE … RETURNING should report, keyed
   * by table name. Missing tables default to 0 returned rows.
   */
  readonly deletedByTable?: Record<string, number>;
  /**
   * Tables whose DELETE should reject (to exercise the best-effort
   * per-table path), keyed by table name → the error to throw.
   */
  readonly rejectDeleteByTable?: Record<string, Error>;
  /** Value returned by `select count(*)` against audit_log. */
  readonly auditLogCount?: number;
  /** When set, the count probe rejects with this error. */
  readonly rejectCountWith?: Error;
}

function makeFakeDb(opts: FakeDbOptions = {}) {
  const deletes: DeleteCapture[] = [];
  let countCalls = 0;

  const db = {
    delete(table: unknown) {
      const name = getTableName(table as never);
      let whereClause: unknown;
      return {
        where(clause: unknown) {
          whereClause = clause;
          return {
            returning(projection: unknown) {
              deletes.push({
                table: name,
                where: whereClause,
                returning: projection,
              });
              const reject = opts.rejectDeleteByTable?.[name];
              if (reject) return Promise.reject(reject);
              const n = opts.deletedByTable?.[name] ?? 0;
              const rows = Array.from({ length: n }, (_v, i) => ({
                id: `${name}-${i}`,
              }));
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
    select(_projection: unknown) {
      return {
        from(_table: unknown) {
          countCalls += 1;
          if (opts.rejectCountWith) return Promise.reject(opts.rejectCountWith);
          return Promise.resolve([{ count: opts.auditLogCount ?? 0 }]);
        },
      };
    },
  };

  return {
    db: db as never,
    deletes,
    get countCalls() {
      return countCalls;
    },
  };
}

// Silence the best-effort console.warn during the failure-path tests.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

// ── resolveRetentionDays ─────────────────────────────────────────────────

describe('resolveRetentionDays (Req 15.5)', () => {
  it('defaults to 90 for undefined / empty / whitespace', () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('   ')).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it('accepts the min (1) and max (3650) bounds', () => {
    expect(resolveRetentionDays('1')).toBe(1);
    expect(resolveRetentionDays('3650')).toBe(3650);
    expect(MIN_RETENTION_DAYS).toBe(1);
    expect(MAX_RETENTION_DAYS).toBe(3650);
  });

  it('accepts a valid in-range value', () => {
    expect(resolveRetentionDays('30')).toBe(30);
    expect(resolveRetentionDays(' 30 ')).toBe(30);
  });

  it('falls back to 90 for out-of-range values (0, below min, above max)', () => {
    expect(resolveRetentionDays('0')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('-5')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('5000')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('3651')).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('falls back to 90 for non-numeric and non-integer values', () => {
    expect(resolveRetentionDays('abc')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('30.5')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('30abc')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('1e3')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('0x1e')).toBe(DEFAULT_RETENTION_DAYS);
  });
});

// ── rotate ────────────────────────────────────────────────────────────────

describe('AuditRotator.rotate — two-table prune (Req 15.5, design §10.2)', () => {
  it('issues a DELETE against both tables and returns the summed count', async () => {
    const { db, deletes } = makeFakeDb({
      deletedByTable: {
        [AUDIT_LOG_TABLE]: 3,
        [LOGIN_ATTEMPTS_TABLE]: 5,
      },
    });
    const rotator = new AuditRotator({ db, retentionDays: 90 });

    const result = await rotator.rotate();

    expect(result).toEqual({ deleted: 8 });
    expect(deletes).toHaveLength(2);
    expect(deletes.map((d) => d.table)).toEqual([
      AUDIT_LOG_TABLE,
      LOGIN_ATTEMPTS_TABLE,
    ]);
    // Each DELETE carries a where-clause (the cutoff) and a returning
    // projection (so we can count rows portably).
    for (const d of deletes) {
      expect(d.where).toBeDefined();
      expect(d.returning).toBeDefined();
    }
  });

  it('returns { deleted: 0 } when nothing matched the cutoff', async () => {
    const { db, deletes } = makeFakeDb(); // no rows configured → 0 each
    const rotator = new AuditRotator({ db, retentionDays: 30 });

    const result = await rotator.rotate();

    expect(result).toEqual({ deleted: 0 });
    expect(deletes).toHaveLength(2);
  });

  it('is best-effort: a failing first DELETE still attempts the second and returns the partial count', async () => {
    const { db, deletes } = makeFakeDb({
      rejectDeleteByTable: {
        [AUDIT_LOG_TABLE]: new Error('lock timeout on audit_log'),
      },
      deletedByTable: {
        [LOGIN_ATTEMPTS_TABLE]: 4,
      },
    });
    const rotator = new AuditRotator({ db, retentionDays: 90 });

    const result = await rotator.rotate();

    // audit_log failed (counts 0), login_attempts deleted 4.
    expect(result).toEqual({ deleted: 4 });
    // Both DELETEs were attempted despite the first failing.
    expect(deletes.map((d) => d.table)).toEqual([
      AUDIT_LOG_TABLE,
      LOGIN_ATTEMPTS_TABLE,
    ]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not throw when both DELETEs fail (returns { deleted: 0 })', async () => {
    const { db } = makeFakeDb({
      rejectDeleteByTable: {
        [AUDIT_LOG_TABLE]: new Error('boom'),
        [LOGIN_ATTEMPTS_TABLE]: new Error('boom'),
      },
    });
    const rotator = new AuditRotator({ db, retentionDays: 90 });

    await expect(rotator.rotate()).resolves.toEqual({ deleted: 0 });
  });
});

// ── maybeRotateOnHighCount ────────────────────────────────────────────────

describe('AuditRotator.maybeRotateOnHighCount — count-trigger + throttle (Req 15.5, design §10.2)', () => {
  it('is a no-op when count ≤ 10,000 (no DELETE issued)', async () => {
    const { db, deletes } = makeFakeDb({ auditLogCount: HIGH_COUNT_THRESHOLD });
    const rotator = new AuditRotator({ db, retentionDays: 90, now: () => 0 });

    const result = await rotator.maybeRotateOnHighCount();

    expect(result).toEqual({ rotated: false });
    expect(deletes).toHaveLength(0);
  });

  it('rotates when count > 10,000', async () => {
    const { db, deletes } = makeFakeDb({
      auditLogCount: HIGH_COUNT_THRESHOLD + 1,
      deletedByTable: {
        [AUDIT_LOG_TABLE]: 2,
        [LOGIN_ATTEMPTS_TABLE]: 7,
      },
    });
    const rotator = new AuditRotator({ db, retentionDays: 90, now: () => 0 });

    const result = await rotator.maybeRotateOnHighCount();

    expect(result).toEqual({ rotated: true, deleted: 9 });
    expect(deletes).toHaveLength(2);
  });

  it('throttles a second call within the hour (no second rotation)', async () => {
    const { db, deletes } = makeFakeDb({
      auditLogCount: HIGH_COUNT_THRESHOLD + 1,
      deletedByTable: { [AUDIT_LOG_TABLE]: 1, [LOGIN_ATTEMPTS_TABLE]: 1 },
    });
    let clock = 0;
    const rotator = new AuditRotator({
      db,
      retentionDays: 90,
      now: () => clock,
    });

    const first = await rotator.maybeRotateOnHighCount();
    expect(first).toEqual({ rotated: true, deleted: 2 });
    expect(deletes).toHaveLength(2);

    // Advance less than an hour → throttled.
    clock = ROTATE_THROTTLE_MS - 1;
    const second = await rotator.maybeRotateOnHighCount();
    expect(second).toEqual({ rotated: false });
    // No new DELETEs issued by the throttled call.
    expect(deletes).toHaveLength(2);
  });

  it('rotates again after the throttle window elapses (≥ 1h)', async () => {
    const { db, deletes } = makeFakeDb({
      auditLogCount: HIGH_COUNT_THRESHOLD + 1,
      deletedByTable: { [AUDIT_LOG_TABLE]: 1, [LOGIN_ATTEMPTS_TABLE]: 1 },
    });
    let clock = 0;
    const rotator = new AuditRotator({
      db,
      retentionDays: 90,
      now: () => clock,
    });

    await rotator.maybeRotateOnHighCount();
    expect(deletes).toHaveLength(2);

    // Advance a full hour → throttle released.
    clock = ROTATE_THROTTLE_MS;
    const again = await rotator.maybeRotateOnHighCount();
    expect(again).toEqual({ rotated: true, deleted: 2 });
    expect(deletes).toHaveLength(4);
  });

  it('does not rotate (and does not throw) when the count probe fails', async () => {
    const { db, deletes } = makeFakeDb({
      rejectCountWith: new Error('count probe failed'),
    });
    const rotator = new AuditRotator({ db, retentionDays: 90, now: () => 0 });

    const result = await rotator.maybeRotateOnHighCount();

    expect(result).toEqual({ rotated: false });
    expect(deletes).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ── constructor env fallback ──────────────────────────────────────────────

describe('AuditRotator retention resolution', () => {
  it('uses the explicit retentionDays when provided', () => {
    const { db } = makeFakeDb();
    const rotator = new AuditRotator({ db, retentionDays: 45 });
    expect(rotator.getRetentionDays()).toBe(45);
  });

  it('falls back to resolving LUMIBASE_AUDIT_RETENTION_DAYS from env', () => {
    const prev = process.env.LUMIBASE_AUDIT_RETENTION_DAYS;
    process.env.LUMIBASE_AUDIT_RETENTION_DAYS = '120';
    try {
      const { db } = makeFakeDb();
      const rotator = new AuditRotator({ db });
      expect(rotator.getRetentionDays()).toBe(120);
    } finally {
      if (prev === undefined) {
        delete process.env.LUMIBASE_AUDIT_RETENTION_DAYS;
      } else {
        process.env.LUMIBASE_AUDIT_RETENTION_DAYS = prev;
      }
    }
  });

  it('defaults to 90 when env is unset/invalid', () => {
    const prev = process.env.LUMIBASE_AUDIT_RETENTION_DAYS;
    delete process.env.LUMIBASE_AUDIT_RETENTION_DAYS;
    try {
      const { db } = makeFakeDb();
      const rotator = new AuditRotator({ db });
      expect(rotator.getRetentionDays()).toBe(90);
    } finally {
      if (prev !== undefined) {
        process.env.LUMIBASE_AUDIT_RETENTION_DAYS = prev;
      }
    }
  });
});
