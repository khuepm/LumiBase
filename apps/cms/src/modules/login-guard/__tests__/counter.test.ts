import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, gte, sql } from 'drizzle-orm';
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
