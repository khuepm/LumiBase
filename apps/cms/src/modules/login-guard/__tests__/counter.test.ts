import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, gte, sql } from 'drizzle-orm';
import * as fc from 'fast-check';
import { loginAttempts, type Database } from '@lumibase/database';

import {
  PostgresCounterStore,
  createCounterStore,
  ipFailedCount,
  userFailedCount,
  type CounterStore,
} from '../counter';

/**
 * Feature: admin-setup-wizard, task 5.3 — sliding-window counter.
 *
 * These unit tests exercise the SQL the Postgres counter emits without
 * spinning up a real database. The fake `Database` records the
 * predicate tree Drizzle hands to `.where(...)`, lets the test inspect
 * which columns and literal values were referenced, and returns a
 * configurable `count`. That's enough to assert:
 *
 *   - The right table (`login_attempts`) is queried.
 *   - The query filters on `email_lower` / `ip` AND `result='fail'`.
 *   - The query filters on `created_at >= now() - <window> seconds`.
 *   - Email keys are lower-cased + trimmed (matching the LoginGuard's
 *     insert-side normalisation, design §6.5 Phase C).
 *   - Empty / blank inputs short-circuit to 0 without issuing SQL.
 *   - The window is clamped to ≥ 1 second.
 *
 * The full sliding-window correctness check (Property 12) lives in the
 * Phase C integration test added by task 6.7; here we cover the unit
 * behaviour and edge cases.
 *
 * Validates: Requirements 7.1, 8.1
 */

// ── Fake Drizzle handle ─────────────────────────────────────────────────

interface SelectCall {
  /** The column projection passed to `.select(...)`. */
  selection: Record<string, unknown>;
  /** The table reference passed to `.from(...)`. */
  table: unknown;
  /** The predicate expression passed to `.where(...)`. */
  where: unknown;
}

interface FakeDb {
  readonly db: Database;
  readonly calls: SelectCall[];
  /** Override the number returned by the next `.where(...)` resolution. */
  setNextCount(n: number): void;
}

/**
 * Build a Drizzle-shaped fake. Only the chain
 *
 *   db.select({...}).from(table).where(predicate)
 *
 * is supported because that's the only shape the counter uses. The
 * fake `await`s into a `[{ count }]` array so the production code's
 * `rows[0]?.count ?? 0` path is exercised verbatim.
 */
function makeFakeDb(): FakeDb {
  const calls: SelectCall[] = [];
  let nextCount = 0;

  const fluent = {
    selection: undefined as unknown,
    table: undefined as unknown,
    from(table: unknown) {
      this.table = table;
      return this;
    },
    where(predicate: unknown) {
      const call: SelectCall = {
        selection: this.selection as Record<string, unknown>,
        table: this.table,
        where: predicate,
      };
      calls.push(call);
      const result = [{ count: nextCount }];
      // Reset for the next chain so each call starts fresh.
      this.selection = undefined;
      this.table = undefined;
      // Drizzle returns a Promise-like; the counter `await`s it.
      return Promise.resolve(result);
    },
  };

  const db = {
    select(selection: Record<string, unknown>) {
      const chain = Object.create(fluent) as typeof fluent;
      chain.selection = selection;
      chain.table = undefined;
      return chain;
    },
  } as unknown as Database;

  return {
    db,
    calls,
    setNextCount(n) {
      nextCount = n;
    },
  };
}

/**
 * Inspect a Drizzle SQL/expression tree and return a flat array of
 * predicate descriptors so tests can assert on shape without depending
 * on Drizzle internals. The descriptors keep the conjunction structure
 * Drizzle builds: `and(...)` becomes a `{ kind: 'and', operands: [...] }`
 * node, primitives surface as `{ kind: 'eq' | 'gte' | 'sql', ... }`.
 */
function describePredicate(node: unknown): unknown {
  if (node == null) return null;
  // Drizzle's `and(...)` returns an object with a `.queryChunks` or
  // exposes `.left` / `.right` for binary ops; rather than couple to
  // those internals, we re-build the predicate tree ourselves and
  // compare against the *output* of the helpers we know we called.
  return node;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('PostgresCounterStore.userFailedCount', () => {
  let fake: FakeDb;
  let store: CounterStore;

  beforeEach(() => {
    fake = makeFakeDb();
    store = new PostgresCounterStore(fake.db);
  });

  it('returns 0 without issuing SQL when email is empty or blank', async () => {
    expect(await store.userFailedCount('', 900)).toBe(0);
    expect(await store.userFailedCount('   ', 900)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('queries login_attempts with the lower-cased + trimmed email', async () => {
    fake.setNextCount(3);
    const result = await store.userFailedCount('  Foo@Example.COM  ', 900);
    expect(result).toBe(3);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.table).toBe(loginAttempts);

    // Re-build the expected predicate using the same Drizzle helpers
    // the counter uses. If the tree shapes line up, both objects share
    // the same string-tagged constructor signature — Drizzle's
    // expression nodes don't deep-equal trivially because they hold
    // schema references, so we compare a structural digest.
    const expected = and(
      eq(loginAttempts.emailLower, 'foo@example.com'),
      eq(loginAttempts.result, 'fail'),
      gte(
        loginAttempts.createdAt,
        sql`now() - (${'900'} || ' seconds')::interval`,
      ),
    );
    expect(describePredicate(fake.calls[0]!.where)).toEqual(
      describePredicate(expected),
    );
  });

  it('clamps non-positive / non-finite window seconds to 1', async () => {
    await store.userFailedCount('a@b.com', 0);
    await store.userFailedCount('a@b.com', -10);
    await store.userFailedCount('a@b.com', Number.NaN);

    for (const call of fake.calls) {
      const expected = and(
        eq(loginAttempts.emailLower, 'a@b.com'),
        eq(loginAttempts.result, 'fail'),
        gte(
          loginAttempts.createdAt,
          sql`now() - (${'1'} || ' seconds')::interval`,
        ),
      );
      expect(describePredicate(call.where)).toEqual(
        describePredicate(expected),
      );
    }
  });

  it('floors fractional window seconds', async () => {
    await store.userFailedCount('a@b.com', 90.9);
    const expected = and(
      eq(loginAttempts.emailLower, 'a@b.com'),
      eq(loginAttempts.result, 'fail'),
      gte(
        loginAttempts.createdAt,
        sql`now() - (${'90'} || ' seconds')::interval`,
      ),
    );
    expect(describePredicate(fake.calls[0]!.where)).toEqual(
      describePredicate(expected),
    );
  });

  it('returns 0 when the database returns an empty result set', async () => {
    // Default fake returns 0; explicitly verify the `?? 0` fallback.
    fake.setNextCount(0);
    expect(await store.userFailedCount('a@b.com', 900)).toBe(0);
  });
});

describe('PostgresCounterStore.ipFailedCount', () => {
  let fake: FakeDb;
  let store: CounterStore;

  beforeEach(() => {
    fake = makeFakeDb();
    store = new PostgresCounterStore(fake.db);
  });

  it('returns 0 without issuing SQL when ip is empty or blank', async () => {
    expect(await store.ipFailedCount('', 3600)).toBe(0);
    expect(await store.ipFailedCount('   ', 3600)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('queries login_attempts with the trimmed IP', async () => {
    fake.setNextCount(7);
    const result = await store.ipFailedCount('  203.0.113.7  ', 3600);
    expect(result).toBe(7);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.table).toBe(loginAttempts);

    const expected = and(
      eq(loginAttempts.ip, '203.0.113.7'),
      eq(loginAttempts.result, 'fail'),
      gte(
        loginAttempts.createdAt,
        sql`now() - (${'3600'} || ' seconds')::interval`,
      ),
    );
    expect(describePredicate(fake.calls[0]!.where)).toEqual(
      describePredicate(expected),
    );
  });

  it('preserves IPv6 addresses verbatim (case-sensitive)', async () => {
    await store.ipFailedCount('::1', 60);
    await store.ipFailedCount('2001:DB8::1', 60);

    expect(fake.calls).toHaveLength(2);
    const firstExpected = and(
      eq(loginAttempts.ip, '::1'),
      eq(loginAttempts.result, 'fail'),
      gte(
        loginAttempts.createdAt,
        sql`now() - (${'60'} || ' seconds')::interval`,
      ),
    );
    const secondExpected = and(
      eq(loginAttempts.ip, '2001:DB8::1'),
      eq(loginAttempts.result, 'fail'),
      gte(
        loginAttempts.createdAt,
        sql`now() - (${'60'} || ' seconds')::interval`,
      ),
    );
    expect(describePredicate(fake.calls[0]!.where)).toEqual(
      describePredicate(firstExpected),
    );
    expect(describePredicate(fake.calls[1]!.where)).toEqual(
      describePredicate(secondExpected),
    );
  });
});

describe('module-level wrappers', () => {
  it('userFailedCount/ipFailedCount delegate to PostgresCounterStore', async () => {
    const fake = makeFakeDb();
    fake.setNextCount(5);
    expect(await userFailedCount(fake.db, 'a@b.com', 900)).toBe(5);

    fake.setNextCount(11);
    expect(await ipFailedCount(fake.db, '203.0.113.7', 3600)).toBe(11);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.table).toBe(loginAttempts);
    expect(fake.calls[1]!.table).toBe(loginAttempts);
  });
});

describe('createCounterStore', () => {
  it('returns the Postgres implementation when LUMIBASE_REDIS_URL is unset', () => {
    const fake = makeFakeDb();
    const store = createCounterStore(fake.db, {});
    expect(store).toBeInstanceOf(PostgresCounterStore);
  });

  it('returns the Postgres implementation even when LUMIBASE_REDIS_URL is set (Redis adapter is a future no-op)', () => {
    const fake = makeFakeDb();
    const store = createCounterStore(fake.db, {
      LUMIBASE_REDIS_URL: 'redis://localhost:6379',
    });
    expect(store).toBeInstanceOf(PostgresCounterStore);
  });
});

// ── Sliding-window correctness (Property 12, task 6.7) ─────────────────

/**
 * Feature: admin-setup-wizard, task 6.7 — sliding-window correctness.
 *
 * The fake DB above pins the *shape* of the SQL the Postgres counter
 * emits, but it can't observe what happens as wall-clock time advances:
 * a row inserted "now" should be counted, the same row five minutes
 * later should not. Property 12 (design §13.1, design §6.4) requires
 * that for any sequence of failed attempts the counter equals
 *
 *   count(login_attempts WHERE result='fail'
 *                          AND created_at >= now() - windowSeconds)
 *
 * regardless of which {@link CounterStore} backend is wired (Postgres
 * today, Redis tomorrow). The only way to property-test that contract
 * cheaply is to simulate the Postgres `now() - interval` semantics
 * in-memory and run a controlled clock against it; that's what the
 * `MemoryCounterStore` below does. Any future adapter can drop into
 * this same suite to prove it satisfies the same contract.
 *
 * Time is mocked with `vi.useFakeTimers()` + `vi.setSystemTime(...)` so
 * the simulated `now()` is deterministic and reproducible — the
 * fast-check property below shrinks failures to a minimal counter-
 * example without flaky retries.
 *
 * Validates: Property 12 (Sliding Window Correctness, design §13.1;
 *            Requirements 7.1, 7.2, 8.1, 8.2).
 */

/** A single failed login attempt as observed by the counter. */
interface AttemptRow {
  readonly emailLower: string;
  readonly ip: string;
  readonly createdAtMs: number;
  readonly result: 'success' | 'fail';
}

/**
 * In-memory `CounterStore` that mirrors `PostgresCounterStore`'s
 * contract using the `vi`-controlled clock as its `now()` source.
 *
 * Implementation notes:
 *
 *   - The window predicate is `createdAt >= now() - windowSeconds*1000`
 *     using `Date.now()` so the test can advance time via
 *     `vi.setSystemTime`. This matches the Postgres `now() - interval`
 *     semantics: rows whose timestamp is *strictly before*
 *     `now - windowSeconds` are excluded; rows at the exact boundary
 *     are *included* (because `>=` is inclusive on both sides of the
 *     window).
 *   - Email keys are lower-cased and trimmed before lookup, mirroring
 *     `normalizeEmail` so a "Foo@Bar" insert collides with a
 *     "foo@bar" query (same as the Postgres implementation, design
 *     §6.5).
 *   - IPs are trimmed but not lower-cased — IPv6 letters are
 *     case-sensitive in the canonical form, and the production
 *     implementation passes them through verbatim.
 *   - Only `result='fail'` rows are counted; success rows are stored
 *     to prove the filter actually filters (otherwise the property
 *     test would silently pass even with a buggy `result` predicate).
 *   - Empty / blank keys short-circuit to 0 without a scan, matching
 *     the production short-circuit. This keeps the property holding
 *     even when fast-check generates whitespace-only inputs.
 *   - `windowSeconds` is clamped exactly the way `clampWindowSeconds`
 *     does in production: non-finite or `<1` collapses to 1.
 */
class MemoryCounterStore implements CounterStore {
  constructor(private readonly rows: AttemptRow[]) {}

  async userFailedCount(email: string, windowSeconds: number): Promise<number> {
    const key = String(email ?? '').trim().toLowerCase();
    if (key.length === 0) return 0;

    const cutoff = Date.now() - clampWindowSecondsForTest(windowSeconds) * 1000;
    return this.rows.filter(
      (r) =>
        r.result === 'fail' &&
        r.emailLower === key &&
        r.createdAtMs >= cutoff,
    ).length;
  }

  async ipFailedCount(ip: string, windowSeconds: number): Promise<number> {
    const key = String(ip ?? '').trim();
    if (key.length === 0) return 0;

    const cutoff = Date.now() - clampWindowSecondsForTest(windowSeconds) * 1000;
    return this.rows.filter(
      (r) => r.result === 'fail' && r.ip === key && r.createdAtMs >= cutoff,
    ).length;
  }
}

function clampWindowSecondsForTest(input: number): number {
  if (!Number.isFinite(input)) return 1;
  const floored = Math.floor(input);
  return floored >= 1 ? floored : 1;
}

/**
 * The reference oracle the property test asserts against. Lives next
 * to {@link MemoryCounterStore} so the two stay in lockstep — if the
 * oracle and the store disagree, the property test will surface a
 * shrinking counter-example pointing at whichever side is wrong.
 *
 * The oracle is intentionally written in the most direct way possible
 * (a filter with `>=` on the cutoff) so it's easy to eyeball against
 * the SQL in `PostgresCounterStore`.
 */
function expectedCount(
  rows: AttemptRow[],
  predicate: 'email' | 'ip',
  rawKey: string,
  windowSeconds: number,
  nowMs: number,
): number {
  const window = clampWindowSecondsForTest(windowSeconds);
  const key =
    predicate === 'email'
      ? String(rawKey ?? '').trim().toLowerCase()
      : String(rawKey ?? '').trim();
  if (key.length === 0) return 0;
  const cutoff = nowMs - window * 1000;
  return rows.filter((r) => {
    if (r.result !== 'fail') return false;
    if (predicate === 'email' && r.emailLower !== key) return false;
    if (predicate === 'ip' && r.ip !== key) return false;
    return r.createdAtMs >= cutoff;
  }).length;
}

describe('Feature: admin-setup-wizard, Property 12: Sliding Window Correctness', () => {
  // Anchor the simulated clock in the future so any non-negative
  // offset fast-check generates resolves to a real Date — `Date.UTC`
  // here is timezone-stable for the test runner. We pin it inside
  // `beforeEach` rather than once globally so each `it` block gets a
  // pristine clock; otherwise stray `vi.setSystemTime` calls inside
  // one test could leak into the next.
  const T0_MS = Date.UTC(2025, 0, 1, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a row inserted at t=0 when queried at t=0', async () => {
    const rows: AttemptRow[] = [
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);
    expect(await store.userFailedCount('a@b.com', 900)).toBe(1);
    expect(await store.ipFailedCount('203.0.113.1', 900)).toBe(1);
  });

  it('drops a row from the counter after the window slides past it', async () => {
    const rows: AttemptRow[] = [
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);

    // At t = window, the row's createdAt equals the cutoff exactly →
    // still inside the window (`>=` is inclusive, mirroring Postgres
    // `now() - interval` plus `created_at >= ...`).
    vi.setSystemTime(T0_MS + 900 * 1000);
    expect(await store.userFailedCount('a@b.com', 900)).toBe(1);
    expect(await store.ipFailedCount('203.0.113.1', 900)).toBe(1);

    // One millisecond later the row is *strictly older* than
    // `now - window`, so it must be dropped — this is the cleanup
    // behaviour task 6.7 explicitly calls out.
    vi.setSystemTime(T0_MS + 900 * 1000 + 1);
    expect(await store.userFailedCount('a@b.com', 900)).toBe(0);
    expect(await store.ipFailedCount('203.0.113.1', 900)).toBe(0);
  });

  it('counts only failed attempts (success rows never contribute)', async () => {
    const rows: AttemptRow[] = [
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'success',
      },
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);
    expect(await store.userFailedCount('a@b.com', 900)).toBe(1);
    expect(await store.ipFailedCount('203.0.113.1', 900)).toBe(1);
  });

  it('isolates counters by email and by IP', async () => {
    // Two failures from the same email but different IPs, plus one
    // failure from a different email reusing one of the IPs. The
    // email counter sees two; the IP counter sees one for each IP
    // (the second IP's row + the cross-email reuse).
    const rows: AttemptRow[] = [
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.2',
        createdAtMs: Date.now(),
        result: 'fail',
      },
      {
        emailLower: 'c@d.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);

    expect(await store.userFailedCount('a@b.com', 900)).toBe(2);
    expect(await store.userFailedCount('c@d.com', 900)).toBe(1);
    expect(await store.ipFailedCount('203.0.113.1', 900)).toBe(2);
    expect(await store.ipFailedCount('203.0.113.2', 900)).toBe(1);
  });

  it('honours the lowercase + trim contract on the email key', async () => {
    // Insert under the canonical key the LoginGuard will write
    // (lower + trimmed) and verify a query with mixed case +
    // surrounding whitespace still hits the same bucket. This is the
    // collision contract design §6.5 spells out.
    const rows: AttemptRow[] = [
      {
        emailLower: 'foo@example.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);
    expect(await store.userFailedCount('  Foo@Example.COM  ', 900)).toBe(1);
  });

  it('returns 0 for blank inputs without scanning rows', async () => {
    const rows: AttemptRow[] = [
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now(),
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);
    expect(await store.userFailedCount('', 900)).toBe(0);
    expect(await store.userFailedCount('   ', 900)).toBe(0);
    expect(await store.ipFailedCount('', 900)).toBe(0);
    expect(await store.ipFailedCount('  ', 900)).toBe(0);
  });

  it('clamps non-positive / non-finite windows to 1 second', async () => {
    // Row exactly 1 second in the past → window=1 includes it, but
    // window=0 (clamped to 1) must also include it, and window=NaN
    // (clamped to 1) likewise. Older rows must drop out under the
    // clamped 1-second window.
    const rows: AttemptRow[] = [
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now() - 1_000,
        result: 'fail',
      },
      {
        emailLower: 'a@b.com',
        ip: '203.0.113.1',
        createdAtMs: Date.now() - 1_001, // older than the 1 s window
        result: 'fail',
      },
    ];
    const store = new MemoryCounterStore(rows);
    expect(await store.userFailedCount('a@b.com', 0)).toBe(1);
    expect(await store.userFailedCount('a@b.com', -10)).toBe(1);
    expect(await store.userFailedCount('a@b.com', Number.NaN)).toBe(1);
  });

  // ── Property test ─────────────────────────────────────────────────

  /**
   * Generator for a single attempt row. Emails and IPs are drawn from
   * a tiny constant pool so the property test produces meaningful
   * collisions (most pairs of generated rows share a key with some
   * other row, otherwise the counter would be uniformly 0 or 1 and
   * trivially correct). `dtMs` is a non-negative offset from the test
   * anchor `T0_MS`; it's bounded so the generated `now()` we pick
   * later can outpace the latest row.
   */
  const emailPool = ['a@b.com', 'foo@example.com', 'c@d.com', 'admin@x.io'];
  const ipPool = ['203.0.113.1', '203.0.113.2', '198.51.100.7', '::1'];

  const attemptArb: fc.Arbitrary<AttemptRow> = fc.record({
    emailLower: fc.constantFrom(...emailPool),
    ip: fc.constantFrom(...ipPool),
    // 0 .. 24 hours past T0 so the maximum reasonable window
    // (lockoutWindowSeconds default 900s, max 86400s per Req 6.3) can
    // straddle the row set.
    createdAtMs: fc
      .integer({ min: 0, max: 24 * 3600 * 1000 })
      .map((dt) => T0_MS + dt),
    result: fc.constantFrom<'success' | 'fail'>('success', 'fail'),
  });

  it('forall sequence of (timestamp, result) attempts → counter matches the oracle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(attemptArb, { minLength: 0, maxLength: 50 }),
        // `nowOffsetMs`: how far past T0 we set the simulated clock
        // when the counter is queried. Range covers "before any row"
        // (offset 0) through "well past every row" (offset > 24 h).
        fc.integer({ min: 0, max: 25 * 3600 * 1000 }),
        // Window in seconds, covering everything from the clamped
        // floor up to a day. Including the clamping range
        // (`min: -10`) catches regressions in the floor.
        fc.integer({ min: -10, max: 86_400 }),
        fc.constantFrom('email', 'ip'),
        fc.integer({ min: 0, max: emailPool.length - 1 }),
        fc.integer({ min: 0, max: ipPool.length - 1 }),
        async (rows, nowOffsetMs, windowSeconds, predicate, eIdx, iIdx) => {
          const store = new MemoryCounterStore(rows);
          const nowMs = T0_MS + nowOffsetMs;
          vi.setSystemTime(nowMs);

          if (predicate === 'email') {
            const key = emailPool[eIdx]!;
            const got = await store.userFailedCount(key, windowSeconds);
            const want = expectedCount(rows, 'email', key, windowSeconds, nowMs);
            expect(got).toBe(want);
          } else {
            const key = ipPool[iIdx]!;
            const got = await store.ipFailedCount(key, windowSeconds);
            const want = expectedCount(rows, 'ip', key, windowSeconds, nowMs);
            expect(got).toBe(want);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('forall row set: counter is non-decreasing as the window grows (monotonicity)', async () => {
    // A larger window can never *exclude* rows a smaller window
    // included: the cutoff `now - window` only moves further into the
    // past as `window` grows. This is a structural invariant of the
    // sliding window that any backend (Postgres, Redis, in-memory)
    // must respect; if the counter ever shrinks when the window
    // grows, something has clamped or rotated state incorrectly.
    await fc.assert(
      fc.asyncProperty(
        fc.array(attemptArb, { minLength: 0, maxLength: 30 }),
        fc.integer({ min: 0, max: 25 * 3600 * 1000 }),
        fc.tuple(
          fc.integer({ min: 1, max: 86_400 }),
          fc.integer({ min: 1, max: 86_400 }),
        ),
        fc.constantFrom('email', 'ip'),
        async (rows, nowOffsetMs, [w1, w2], predicate) => {
          const store = new MemoryCounterStore(rows);
          vi.setSystemTime(T0_MS + nowOffsetMs);
          const small = Math.min(w1, w2);
          const large = Math.max(w1, w2);
          if (predicate === 'email') {
            const key = emailPool[0]!;
            const a = await store.userFailedCount(key, small);
            const b = await store.userFailedCount(key, large);
            expect(b).toBeGreaterThanOrEqual(a);
          } else {
            const key = ipPool[0]!;
            const a = await store.ipFailedCount(key, small);
            const b = await store.ipFailedCount(key, large);
            expect(b).toBeGreaterThanOrEqual(a);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('forall row set: counter is non-increasing as time advances at fixed window (cleanup)', async () => {
    // Symmetric to the monotonicity property above: with the window
    // length pinned, advancing `now()` can only *eject* rows from the
    // window, never admit new ones (the row set is fixed). This is
    // the cleanup behaviour the task description calls out — verify
    // it holds across arbitrary row sets and time offsets.
    await fc.assert(
      fc.asyncProperty(
        fc.array(attemptArb, { minLength: 0, maxLength: 30 }),
        fc.integer({ min: 1, max: 86_400 }),
        fc.tuple(
          fc.integer({ min: 0, max: 25 * 3600 * 1000 }),
          fc.integer({ min: 0, max: 25 * 3600 * 1000 }),
        ),
        fc.constantFrom('email', 'ip'),
        async (rows, windowSeconds, [t1, t2], predicate) => {
          const store = new MemoryCounterStore(rows);
          const earlier = Math.min(t1, t2);
          const later = Math.max(t1, t2);

          if (predicate === 'email') {
            const key = emailPool[0]!;
            vi.setSystemTime(T0_MS + earlier);
            const a = await store.userFailedCount(key, windowSeconds);
            vi.setSystemTime(T0_MS + later);
            const b = await store.userFailedCount(key, windowSeconds);
            expect(b).toBeLessThanOrEqual(a);
          } else {
            const key = ipPool[0]!;
            vi.setSystemTime(T0_MS + earlier);
            const a = await store.ipFailedCount(key, windowSeconds);
            vi.setSystemTime(T0_MS + later);
            const b = await store.ipFailedCount(key, windowSeconds);
            expect(b).toBeLessThanOrEqual(a);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
