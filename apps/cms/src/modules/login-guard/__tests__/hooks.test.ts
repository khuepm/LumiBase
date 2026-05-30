import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { loginAttempts, users, type Database } from '@lumibase/database';

import {
  recordLoginFailure,
  recordLoginSuccess,
} from '../hooks';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../../setup/policy-codec';
import type { CounterStore } from '../counter';

/**
 * Unit tests for the LoginGuard onFailure / onSuccess hooks
 * (admin-setup-wizard task 6.2; Req 7.1, 7.2, 7.4, 8.1, 8.2, 8.6;
 * design §6.3).
 *
 * The hooks talk to the DB through Drizzle's fluent builder; rather
 * than spin up Postgres, we stub out the four fluent methods we
 * actually use (`insert(...).values(...)` and
 * `update(...).set(...).where(...)`). The stubs record their inputs
 * so we can assert on the rows that *would* have been written
 * without needing a live DB.
 *
 * The counter store is faked too so we can drive the threshold logic
 * deterministically.
 */

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}
interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
  predicateText: string;
}

function makeFakeDb(): {
  db: Database;
  inserts: InsertCall[];
  updates: UpdateCall[];
} {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  const db = {
    insert(table: unknown) {
      return {
        async values(values: Record<string, unknown>) {
          inserts.push({ table, values });
        },
      };
    },
    update(table: unknown) {
      let captured: { set: Record<string, unknown>; predicateText: string } = {
        set: {},
        predicateText: '',
      };
      const chain = {
        set(values: Record<string, unknown>) {
          captured.set = values;
          return this;
        },
        async where(predicate: unknown) {
          // Pull the raw template literal segments out of the SQL
          // chunk for a coarse assertion on the predicate shape.
          const sqlChunk = predicate as { queryChunks?: unknown[] };
          let predicateText = '';
          if (sqlChunk && Array.isArray(sqlChunk.queryChunks)) {
            for (const chunk of sqlChunk.queryChunks) {
              if (
                typeof chunk === 'object' &&
                chunk !== null &&
                'value' in (chunk as Record<string, unknown>) &&
                Array.isArray(
                  (chunk as { value?: unknown }).value as unknown,
                )
              ) {
                predicateText +=
                  ((chunk as { value: string[] }).value.join('') ?? '');
              } else if (typeof chunk === 'string') {
                predicateText += chunk;
              }
            }
          }
          updates.push({
            table,
            set: captured.set,
            predicateText: predicateText || JSON.stringify(predicate),
          });
        },
      };
      return chain;
    },
  } as unknown as Database;

  return { db, inserts, updates };
}

function makeCounter(opts: {
  user?: number | ((email: string, win: number) => number);
  ip?: number | ((ip: string, win: number) => number);
}): CounterStore {
  return {
    async userFailedCount(email, win) {
      const u = opts.user ?? 0;
      return typeof u === 'function' ? u(email, win) : u;
    },
    async ipFailedCount(ip, win) {
      const i = opts.ip ?? 0;
      return typeof i === 'function' ? i(ip, win) : i;
    },
  };
}

function freshPolicy(overrides?: Partial<LockoutPolicy>): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
    ...overrides,
  };
}

const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');

// ── recordLoginFailure ─────────────────────────────────────────────────

describe('recordLoginFailure — Req 7.1, 7.2, 8.1, 8.2, 8.6', () => {
  it('inserts a fail row into login_attempts (Req 7.1, 8.1)', async () => {
    const { db, inserts } = makeFakeDb();
    const counter = makeCounter({ user: 1, ip: 1 });

    await recordLoginFailure(
      db,
      counter,
      freshPolicy(),
      {
        email: '  Foo@Example.COM  ',
        ip: '203.0.113.7',
        reason: 'invalid_credentials',
        userAgent: 'curl/8.0',
        userId: null,
      },
      FIXED_NOW,
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(loginAttempts);
    expect(inserts[0]!.values).toMatchObject({
      emailLower: 'foo@example.com',
      ip: '203.0.113.7',
      result: 'fail',
      reason: 'invalid_credentials',
      userAgent: 'curl/8.0',
      userId: null,
    });
  });

  it('does NOT lock the user when failedCount is below threshold (Req 7.2)', async () => {
    const { db, updates } = makeFakeDb();
    // Threshold is 5; the counter says 4 — one below.
    const counter = makeCounter({ user: 4, ip: 0 });

    const out = await recordLoginFailure(
      db,
      counter,
      freshPolicy({ userMaxFailedAttempts: 5 }),
      {
        email: 'a@b.com',
        ip: '203.0.113.7',
        reason: 'invalid_credentials',
      },
      FIXED_NOW,
    );

    // Only the loginAttempts insert ran; no user update.
    expect(updates).toHaveLength(0);
    expect(out.userLocked).toBe(false);
    expect(out.userFailedCount).toBe(4);
  });

  it('locks the user when failedCount reaches threshold (Req 7.2)', async () => {
    const { db, updates } = makeFakeDb();
    const counter = makeCounter({ user: 5, ip: 0 });
    const policy = freshPolicy({
      userMaxFailedAttempts: 5,
      userLockoutDurationSeconds: 900,
    });

    const out = await recordLoginFailure(
      db,
      counter,
      policy,
      {
        email: 'a@b.com',
        ip: '203.0.113.7',
        reason: 'invalid_credentials',
      },
      FIXED_NOW,
    );

    expect(out.userLocked).toBe(true);
    expect(out.userFailedCount).toBe(5);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(users);
    const setBody = updates[0]!.set;
    expect(setBody.failedCount).toBe(5);
    expect(setBody.lockedUntil).toBeInstanceOf(Date);
    expect((setBody.lockedUntil as Date).getTime()).toBe(
      FIXED_NOW.getTime() + 900 * 1000,
    );
  });

  it('locks above threshold too (e.g. 7th attempt with threshold 5)', async () => {
    const { db, updates } = makeFakeDb();
    const counter = makeCounter({ user: 7, ip: 0 });
    const out = await recordLoginFailure(
      db,
      counter,
      freshPolicy({ userMaxFailedAttempts: 5 }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(out.userLocked).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it('does not look up users.lockedUntil when email is blank (Req 7.5 timing parity)', async () => {
    const { db, updates } = makeFakeDb();
    const counter = makeCounter({ user: 999, ip: 0 });

    const out = await recordLoginFailure(
      db,
      counter,
      freshPolicy({ userMaxFailedAttempts: 5 }),
      { email: '   ', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );

    // Lockout transition skipped — there's no email to key on.
    expect(out.userLocked).toBe(false);
    expect(out.userFailedCount).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('flags ipBlocked when ipFailedCount ≥ ipMaxFailedAttempts (Req 8.2, 8.6)', async () => {
    const { db } = makeFakeDb();
    const counter = makeCounter({ user: 0, ip: 25 });
    const out = await recordLoginFailure(
      db,
      counter,
      freshPolicy({ ipMaxFailedAttempts: 20 }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(out.ipBlocked).toBe(true);
    expect(out.ipFailedCount).toBe(25);
  });

  it('enforces the Req 8.2 hard floor of 3 even when policy is corrupted', async () => {
    // A corrupt settings row claims the threshold is 1; the floor of
    // 3 means we shouldn't flag ipBlocked until at least 3 fails.
    const { db } = makeFakeDb();
    const counter = makeCounter({ user: 0, ip: 2 });
    const out = await recordLoginFailure(
      db,
      counter,
      freshPolicy({
        ipMaxFailedAttempts: 1 as unknown as LockoutPolicy['ipMaxFailedAttempts'],
      }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(out.ipBlocked).toBe(false);
  });

  it('uses lockoutWindowSeconds when querying the counter', async () => {
    const { db } = makeFakeDb();
    const userSpy = vi.fn().mockResolvedValue(0);
    const ipSpy = vi.fn().mockResolvedValue(0);
    const counter: CounterStore = {
      userFailedCount: userSpy,
      ipFailedCount: ipSpy,
    };
    await recordLoginFailure(
      db,
      counter,
      freshPolicy({ lockoutWindowSeconds: 1234 }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(userSpy).toHaveBeenCalledWith('a@b.com', 1234);
    expect(ipSpy).toHaveBeenCalledWith('203.0.113.7', 1234);
  });

  it('treats a counter read failure as 0 (no throw)', async () => {
    const { db } = makeFakeDb();
    const counter: CounterStore = {
      userFailedCount: vi.fn().mockRejectedValue(new Error('db down')),
      ipFailedCount: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const out = await recordLoginFailure(
      db,
      counter,
      freshPolicy(),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(out.userLocked).toBe(false);
    expect(out.ipBlocked).toBe(false);
    expect(out.userFailedCount).toBe(0);
    expect(out.ipFailedCount).toBe(0);
  });

  it('inserts the loginAttempts row before issuing the counter read', async () => {
    // The SQL counter (PostgresCounterStore) reads `login_attempts`
    // directly, so the insert must happen first or the counter sees
    // an off-by-one. We assert on call order through the fake.
    const events: string[] = [];
    const counter: CounterStore = {
      async userFailedCount() {
        events.push('userFailedCount');
        return 0;
      },
      async ipFailedCount() {
        events.push('ipFailedCount');
        return 0;
      },
    };
    const db = {
      insert(_t: unknown) {
        return {
          async values() {
            events.push('insert');
          },
        };
      },
      update(_t: unknown) {
        return {
          set() {
            return this;
          },
          async where() {
            events.push('update');
          },
        };
      },
    } as unknown as Database;

    await recordLoginFailure(
      db,
      counter,
      freshPolicy(),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(events[0]).toBe('insert');
    expect(events.slice(1)).toEqual(['userFailedCount', 'ipFailedCount']);
  });
});

// ── recordLoginSuccess ─────────────────────────────────────────────────

describe('recordLoginSuccess — Req 7.1, 7.4', () => {
  it('inserts a success row into login_attempts (Req 7.1)', async () => {
    const { db, inserts } = makeFakeDb();
    await recordLoginSuccess(db, {
      userId: 'usr_123',
      email: '  Foo@Example.COM  ',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(loginAttempts);
    expect(inserts[0]!.values).toMatchObject({
      emailLower: 'foo@example.com',
      userId: 'usr_123',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      result: 'success',
      reason: null,
    });
  });

  it('resets failedCount, lockedUntil, and failedCountWindowStart (Req 7.4)', async () => {
    const { db, updates } = makeFakeDb();
    await recordLoginSuccess(db, {
      userId: 'usr_123',
      email: 'foo@example.com',
      ip: '203.0.113.7',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(users);
    expect(updates[0]!.set).toEqual({
      failedCount: 0,
      lockedUntil: null,
      failedCountWindowStart: null,
    });
  });

  it('updates the users row exactly once on success', async () => {
    // The hook keys the reset by `users.id` rather than by email so
    // a future case-mutation of the email column can't split the
    // reset across rows. We verify by call count + targeted table
    // rather than by the SQL predicate shape (Drizzle's `eq()` hides
    // its params behind a Param object that's awkward to introspect
    // through a stub).
    const { db, updates } = makeFakeDb();
    await recordLoginSuccess(db, {
      userId: 'usr_xyz',
      email: 'foo@example.com',
      ip: '203.0.113.7',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(users);
  });

  it('does NOT touch the IP counter or any IP-keyed row on success', async () => {
    // Req 7.4 only asks us to reset the user-level counter. The IP
    // counter should keep ticking down with the sliding window —
    // resetting it on a single success would let credential-stuffing
    // bots launder one IP via a single legitimate login.
    const { db, inserts, updates } = makeFakeDb();
    await recordLoginSuccess(db, {
      userId: 'usr_123',
      email: 'foo@example.com',
      ip: '203.0.113.7',
    });
    // One insert (loginAttempts) + one update (users), no other ops.
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });
});

// keep import side-effects tidy
void sql;
