import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { users, type Database } from '@lumibase/database';

import {
  loginGuardMiddleware,
  precheckLogin,
  type PrecheckOutcome,
} from '../middleware';
import { STANDARD_LOCKOUT_POLICY, type LockoutPolicy } from '../../setup/policy-codec';
import type { CounterStore } from '../counter';
import type { AppEnv } from '../../../env';

/**
 * Unit tests for the Login Guard middleware (admin-setup-wizard task
 * 6.1; Req 7.3, 8.3; design §6.3, Property 8).
 *
 * These tests exercise the four branches called out in the task brief:
 *
 *   1. `lockedUntil > now()` short-circuits with 423 ACCOUNT_LOCKED +
 *      `retryAfterSeconds` (Req 7.3).
 *   2. The IP failure counter ≥ `ipMaxFailedAttempts` short-circuits
 *      with 429 + `Retry-After` header (Req 8.3).
 *   3. Neither condition holds → middleware calls `next()` and the
 *      downstream handler runs.
 *   4. No-enumeration parity (Req 7.5 / Property 8): the response body
 *      and the SELECT shape are identical for an email that exists
 *      but isn't locked vs. an email that doesn't exist.
 *
 * The DB and counter are stubbed so the tests never touch Postgres —
 * we don't need a real database to verify the middleware's routing
 * decisions.
 */

// ── DB fake ─────────────────────────────────────────────────────────────

interface UsersRow {
  email: string;
  lockedUntil: Date | null;
}

interface FakeDbState {
  rows: UsersRow[];
  selectCalls: Array<{ predicateText: string }>;
}

function makeFakeDb(initial: { rows?: UsersRow[] } = {}): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    rows: initial.rows ?? [],
    selectCalls: [],
  };

  // Minimal Drizzle fluent stub. The middleware only ever runs:
  //   db.select({ lockedUntil: users.lockedUntil }).from(users)
  //     .where(sql`lower(...) = ${...}`).limit(1)
  // The `.execute(...)` method handles the policy loader's raw SQL.
  let nextSelection: Record<string, unknown> | undefined;

  const fluent = {
    from(_table: unknown) {
      return this;
    },
    where(predicate: unknown) {
      // The predicate is a Drizzle SQL chunk: `sql\`lower(${col}) = ${email}\``.
      // The compiled `queryChunks` array interleaves `StringChunk`
      // objects (template literal segments) with bound params. Bound
      // string params come through as plain JS strings (verified via
      // the Drizzle source), so the email we want to match is "the
      // first plain-string entry in queryChunks". We capture it for
      // row lookup and for the test's own assertions on shape.
      const sqlChunk = predicate as { queryChunks?: unknown[] };
      let captured = '';
      if (sqlChunk && Array.isArray(sqlChunk.queryChunks)) {
        for (const chunk of sqlChunk.queryChunks) {
          if (typeof chunk === 'string') {
            captured = chunk;
            break;
          }
        }
      }
      state.selectCalls.push({ predicateText: captured });
      return {
        limit(_n: number) {
          const lower = captured.toLowerCase();
          const row = state.rows.find((r) => r.email.toLowerCase() === lower);
          if (!row) return Promise.resolve([]);
          // Only project the columns the middleware asked for.
          const out: Record<string, unknown> = {};
          if (nextSelection) {
            for (const key of Object.keys(nextSelection)) {
              if (key === 'lockedUntil') out.lockedUntil = row.lockedUntil;
            }
          } else {
            out.lockedUntil = row.lockedUntil;
          }
          return Promise.resolve([out]);
        },
      };
    },
  };

  const db = {
    select(selection?: Record<string, unknown>) {
      nextSelection = selection;
      return fluent;
    },
    execute() {
      // Policy loader path. Returning an empty array makes the loader
      // fall back to STANDARD_LOCKOUT_POLICY, which is what most tests
      // expect; tests that need a custom policy inject `loadPolicy`.
      return Promise.resolve([]);
    },
  } as unknown as Database;

  return { db, state };
}

// ── Counter fake ────────────────────────────────────────────────────────

function makeFakeCounter(opts: {
  ipFailed?: number;
  userFailed?: number;
} = {}): {
  store: CounterStore;
  ipCalls: number;
  userCalls: number;
} {
  const tracker = { ipCalls: 0, userCalls: 0 };
  const store: CounterStore = {
    async ipFailedCount(_ip, _window) {
      tracker.ipCalls += 1;
      return opts.ipFailed ?? 0;
    },
    async userFailedCount(_email, _window) {
      tracker.userCalls += 1;
      return opts.userFailed ?? 0;
    },
  };
  return Object.assign(tracker, { store });
}

function counterFactory(store: CounterStore) {
  return () => store;
}

// ── Helpers ────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');

/**
 * Clone the frozen Standard preset into a mutable {@link LockoutPolicy}.
 * The preset is `Object.freeze`d at the codec level (so it doubles as a
 * single-source-of-truth constant), which makes its `notifyChannels`
 * a `readonly NotificationChannel[]`. Spreading it loses the readonly
 * marker, but TypeScript still narrows the array type on the resulting
 * object literal to `readonly`. Build a fresh mutable array here so the
 * tests can assign to `LockoutPolicy` directly without an `as` escape.
 */
function freshPolicy(overrides?: Partial<LockoutPolicy>): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
    ...overrides,
  };
}

function buildApp(opts: {
  db: Database;
  store: CounterStore;
  policy?: LockoutPolicy;
  now?: Date;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', opts.db);
    await next();
  });
  app.use(
    '/auth/login',
    loginGuardMiddleware({
      now: () => opts.now ?? FIXED_NOW,
      counterStore: counterFactory(opts.store),
      loadPolicy: async () => opts.policy ?? freshPolicy(),
      ipExtraction: { getRemoteAddress: () => '127.0.0.1' },
    }),
  );
  let downstreamCalls = 0;
  app.post('/auth/login', (c) => {
    downstreamCalls += 1;
    return c.json({ ok: true, hits: downstreamCalls }, 200);
  });
  return app;
}

async function postLogin(
  app: Hono<AppEnv>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

// ── 1. Account lockout (Req 7.3) ───────────────────────────────────────

describe('loginGuardMiddleware — account lockout (Req 7.3)', () => {
  it('returns 423 ACCOUNT_LOCKED with retryAfterSeconds when lockedUntil > now()', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000); // +5 minutes
    const { db } = makeFakeDb({
      rows: [{ email: 'admin@example.com', lockedUntil }],
    });
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: 'admin@example.com', password: 'x' });
    expect(res.status).toBe(423);
    const body = (await res.json()) as {
      errors: Array<{ code: string; retryAfterSeconds: number }>;
    };
    expect(body.errors[0]!.code).toBe('ACCOUNT_LOCKED');
    expect(body.errors[0]!.retryAfterSeconds).toBe(300);
  });

  it('clamps retryAfterSeconds to ≥ 1 when lockedUntil is sub-second from now', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 250); // 250ms in future
    const { db } = makeFakeDb({
      rows: [{ email: 'admin@example.com', lockedUntil }],
    });
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: 'admin@example.com', password: 'x' });
    expect(res.status).toBe(423);
    const body = (await res.json()) as {
      errors: Array<{ retryAfterSeconds: number }>;
    };
    expect(body.errors[0]!.retryAfterSeconds).toBe(1);
  });

  it('passes through when lockedUntil is in the past', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() - 1000);
    const { db } = makeFakeDb({
      rows: [{ email: 'admin@example.com', lockedUntil }],
    });
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: 'admin@example.com', password: 'x' });
    expect(res.status).toBe(200);
  });

  it('passes through when lockedUntil is null', async () => {
    const { db } = makeFakeDb({
      rows: [{ email: 'admin@example.com', lockedUntil: null }],
    });
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: 'admin@example.com', password: 'x' });
    expect(res.status).toBe(200);
  });

  it('matches email case-insensitively (uses lower() comparison)', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 60_000);
    const { db } = makeFakeDb({
      rows: [{ email: 'Admin@Example.com', lockedUntil }],
    });
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: '  admin@example.COM  ', password: 'x' });
    expect(res.status).toBe(423);
  });

  it('does NOT call the downstream handler when account is locked', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 60_000);
    const { db } = makeFakeDb({
      rows: [{ email: 'admin@example.com', lockedUntil }],
    });
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: 'admin@example.com', password: 'x' });
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBeUndefined();
  });
});

// ── 2. IP rate-limit (Req 8.3) ─────────────────────────────────────────

describe('loginGuardMiddleware — IP rate-limit (Req 8.3)', () => {
  it('returns 429 with Retry-After header when ipFailedCount ≥ ipMaxFailedAttempts', async () => {
    const { db } = makeFakeDb();
    const counter = makeFakeCounter({ ipFailed: 20 });
    const policy: LockoutPolicy = freshPolicy({
      ipMaxFailedAttempts: 20,
      ipLockoutDurationSeconds: 3600,
    });
    const app = buildApp({ db, store: counter.store, policy });

    const res = await postLogin(app, { email: 'who@x.com', password: 'x' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('IP_BLOCKED');
  });

  it('does not 429 when ipFailedCount is below the threshold', async () => {
    const { db } = makeFakeDb();
    const counter = makeFakeCounter({ ipFailed: 19 });
    const policy: LockoutPolicy = freshPolicy({
      ipMaxFailedAttempts: 20,
    });
    const app = buildApp({ db, store: counter.store, policy });

    const res = await postLogin(app, { email: 'who@x.com', password: 'x' });
    expect(res.status).toBe(200);
  });

  it('enforces the Req 8.2 hard floor of 3 even if policy says less', async () => {
    // Policy claims max=2 (below the spec floor). Even though the
    // counter (2) hits the policy's claim, the guard refuses to block
    // until at least 3 because Req 8.2 says "ipMaxFailedAttempts ≥ 3".
    const { db } = makeFakeDb();
    const counter = makeFakeCounter({ ipFailed: 2 });
    const policy: LockoutPolicy = freshPolicy({
      // The codec rejects values below 5 normally, but a corrupted DB
      // row could produce one — defend in depth.
      ipMaxFailedAttempts: 2 as unknown as LockoutPolicy['ipMaxFailedAttempts'],
    });
    const app = buildApp({ db, store: counter.store, policy });

    const res = await postLogin(app, { email: 'who@x.com', password: 'x' });
    expect(res.status).toBe(200);
  });

  it('account-lock takes precedence over IP-block (single 423 response)', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 60_000);
    const { db } = makeFakeDb({
      rows: [{ email: 'admin@example.com', lockedUntil }],
    });
    const counter = makeFakeCounter({ ipFailed: 1000 });
    const policy: LockoutPolicy = freshPolicy({
      ipMaxFailedAttempts: 20,
    });
    const app = buildApp({ db, store: counter.store, policy });

    const res = await postLogin(app, { email: 'admin@example.com', password: 'x' });
    expect(res.status).toBe(423);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('ACCOUNT_LOCKED');
    // The IP counter wasn't even consulted because the lockout path
    // short-circuits first.
    expect(counter.ipCalls).toBe(0);
  });

  it('uses the configured lockoutWindowSeconds when querying the counter', async () => {
    const { db } = makeFakeDb();
    const ipFailedCountSpy = vi.fn().mockResolvedValue(0);
    const store: CounterStore = {
      ipFailedCount: ipFailedCountSpy,
      userFailedCount: vi.fn().mockResolvedValue(0),
    };
    const policy: LockoutPolicy = freshPolicy({
      lockoutWindowSeconds: 1234,
    });
    const app = buildApp({ db, store, policy });

    await postLogin(app, { email: 'who@x.com', password: 'x' });
    expect(ipFailedCountSpy).toHaveBeenCalledTimes(1);
    expect(ipFailedCountSpy.mock.calls[0]![1]).toBe(1234);
  });
});

// ── 3. Pass-through ────────────────────────────────────────────────────

describe('loginGuardMiddleware — pass-through', () => {
  it('calls next() when neither lockout nor IP block applies', async () => {
    const { db } = makeFakeDb();
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await postLogin(app, { email: 'a@b.com', password: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('forwards to next() even when the request body is malformed', async () => {
    const { db } = makeFakeDb();
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    const res = await app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    // The middleware reads `email` defensively (returns ''), runs the
    // checks against the empty key, finds nothing, and forwards.
    // Hono's downstream handler in this test isn't a JSON-parsing one,
    // so 200 from the test handler is the expected outcome.
    expect(res.status).toBe(200);
  });
});

// ── 4. No-enumeration parity (Req 7.5 / Property 8) ────────────────────

describe('loginGuardMiddleware — no-enumeration on login fail (Req 7.5, Property 8)', () => {
  it('issues exactly one users SELECT regardless of whether the email exists', async () => {
    const existingDb = makeFakeDb({
      rows: [{ email: 'existing@example.com', lockedUntil: null }],
    });
    const missingDb = makeFakeDb();
    const counter = makeFakeCounter();

    const appExisting = buildApp({ db: existingDb.db, store: counter.store });
    const appMissing = buildApp({ db: missingDb.db, store: counter.store });

    await postLogin(appExisting, { email: 'existing@example.com', password: 'x' });
    await postLogin(appMissing, { email: 'missing@example.com', password: 'x' });

    expect(existingDb.state.selectCalls.length).toBe(1);
    expect(missingDb.state.selectCalls.length).toBe(1);
  });

  it('produces an identical 200 response shape for both email-found and email-not-found', async () => {
    const existingDb = makeFakeDb({
      rows: [{ email: 'existing@example.com', lockedUntil: null }],
    });
    const missingDb = makeFakeDb();
    const counter = makeFakeCounter();

    const appExisting = buildApp({ db: existingDb.db, store: counter.store });
    const appMissing = buildApp({ db: missingDb.db, store: counter.store });

    const r1 = await postLogin(appExisting, { email: 'existing@example.com', password: 'x' });
    const r2 = await postLogin(appMissing, { email: 'missing@example.com', password: 'x' });

    expect(r1.status).toBe(r2.status);
    const t1 = await r1.text();
    const t2 = await r2.text();
    expect(t1).toBe(t2);
  });

  it('does not change SELECT shape when email is empty/blank', async () => {
    // Even an empty email key triggers exactly one SELECT, so an
    // attacker can't tell "did the middleware short-circuit because
    // the body was missing email" via the DB profile.
    const { db, state } = makeFakeDb();
    const counter = makeFakeCounter();
    const app = buildApp({ db, store: counter.store });

    await postLogin(app, { password: 'x' });
    expect(state.selectCalls.length).toBe(1);
  });
});

// ── precheckLogin (pure helper) ────────────────────────────────────────

describe('precheckLogin — pure verdict function', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns allow:true when no row matches and counter is below threshold', async () => {
    const { db } = makeFakeDb();
    const { store } = makeFakeCounter({ ipFailed: 0 });
    const verdict = await precheckLogin({
      db,
      counter: store,
      policy: freshPolicy(),
      email: 'nobody@example.com',
      ip: '203.0.113.7',
      now: FIXED_NOW,
    });
    expect(verdict).toEqual<PrecheckOutcome>({ allow: true });
  });

  it('returns 423 verdict with retryAfterSeconds when locked', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 90_000);
    const { db } = makeFakeDb({
      rows: [{ email: 'a@b.com', lockedUntil }],
    });
    const { store } = makeFakeCounter();
    const verdict = await precheckLogin({
      db,
      counter: store,
      policy: freshPolicy(),
      email: 'a@b.com',
      ip: '203.0.113.7',
      now: FIXED_NOW,
    });
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.status).toBe(423);
    expect(verdict.body.errors[0]!.code).toBe('ACCOUNT_LOCKED');
    expect(verdict.body.errors[0]!.retryAfterSeconds).toBe(90);
  });

  it('returns 429 verdict with retry-after header when IP block triggers', async () => {
    const { db } = makeFakeDb();
    const { store } = makeFakeCounter({ ipFailed: 50 });
    const verdict = await precheckLogin({
      db,
      counter: store,
      policy: freshPolicy({
        ipMaxFailedAttempts: 20,
        ipLockoutDurationSeconds: 1800,
      }),
      email: 'a@b.com',
      ip: '203.0.113.7',
      now: FIXED_NOW,
    });
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.status).toBe(429);
    expect(verdict.headers?.['retry-after']).toBe('1800');
    expect(verdict.body.errors[0]!.code).toBe('IP_BLOCKED');
  });
});

// keep the import list tidy — `users` is referenced for typing only.
void users;
