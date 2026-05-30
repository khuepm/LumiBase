import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from 'vitest';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  adminBackupCodes,
  createDb,
  loginAttempts,
  users,
  type Database,
} from '@lumibase/database';

import type { AppEnv } from '../env';
import { recoveryRouter } from '../modules/recovery/routes';
import {
  __resetRecoveryRateLimitForTests,
  RECOVERY_RATE_LIMIT,
} from '../modules/recovery/rate-limit';
import { RecoveryService } from '../modules/recovery/service';
import { SetupService } from '../modules/setup/service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../modules/setup/policy-codec';

/**
 * Integration tests for the account-recovery flow
 * (admin-setup-wizard task 10.9; Req 14.4, 14.7, 14.8; design §13.2,
 * Property 4).
 *
 * Driven through the real PUBLIC `recoveryRouter` mounted at
 * `/api/v1/admin/security` (mirroring `index.ts`) so the shared 3/IP/hour
 * rate limiter, the body validation, and the recovery service's full
 * DB path (code lookup → PBKDF2 verify → mark-used → lockout clear → IP
 * drain) all run end-to-end against Postgres:
 *
 *   1. **Lock → recover → unlock + adminPath (Req 14.4, Property 4)** —
 *      seed the bootstrap admin (capturing the REAL plaintext backup
 *      codes that task 10.2 persisted into `admin_backup_codes`), force
 *      a lockout (`users.lockedUntil` in the future + a burst of
 *      `result='fail'` rows for the email/IP), then POST `/recover` with
 *      a real plaintext code. Asserts the 200 body returns the
 *      `adminPath` + a non-empty `oneTimeUnlockToken`, and that the DB
 *      converged: the matched code row is stamped `used_at`/`used_from_ip`,
 *      the user lockout cleared, and the IP's recent failures drained.
 *
 *   2. **Backup code single-use (Req 14.7, Property 4)** — a code that
 *      recovered successfully cannot be redeemed twice: the second
 *      `/recover` with the SAME plaintext returns 401 INVALID_BACKUP_CODE
 *      (its `used_at` is now set, so it falls out of the
 *      `WHERE used_at IS NULL` candidate set). A DIFFERENT still-unused
 *      code still works.
 *
 *   3. **Rate limit 3/IP/hour (Req 14.8)** — three recovery requests from
 *      one IP (mixing `/recover` and `/forgot-path`, which SHARE one
 *      budget) all pass; the 4th from the same IP is 429 RATE_LIMITED
 *      with a positive `Retry-After`. A request from a DIFFERENT IP is
 *      still allowed — per-IP isolation.
 *
 *   4. **forgot-path generic 200 (Req 14.5)** — a known and an unknown
 *      email both return 200 `{ sent: true }` (anti-enumeration).
 *
 * ── Test wiring choices ──────────────────────────────────────────────────
 *
 * - Uses the project's shared `DATABASE_URL` pattern: when the variable
 *   is unset or the DB is unreachable the suite skips with a warning so
 *   local-only `pnpm test` doesn't break.
 *
 * - The recovery rate limiter (`modules/recovery/rate-limit.ts`) and the
 *   recovery service's default token stores are PROCESS-SHARED module
 *   singletons. `beforeEach` calls `__resetRecoveryRateLimitForTests()`
 *   so a prior test's requests can't leak into the next one's 3/IP/hour
 *   budget.
 *
 * - We inject a fresh `RecoveryService` via the `recoveryServiceOverride`
 *   context key. The injected service is the REAL service bound to the
 *   test Postgres `db` — it exercises the full DB path — but with
 *   `sleep: () => Promise.resolve()` so the 200–500ms anti-timing delay
 *   the real route would otherwise apply on every call is skipped. This
 *   keeps the suite both REAL (Postgres-backed) AND fast (no cumulative
 *   multi-second waits across the ~10 recover/forgot calls).
 *
 * **Validates: Requirements 14.4, 14.7, 14.8**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

/** Shared bootstrap admin credentials. */
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple!42';

/** The Admin Path the recovery flow must hand back (design §4.7). */
const ADMIN_PATH = '/lumi-7f3a9c';

/** IP that drives the happy-path recover (its fail burst is drained). */
const RECOVER_IP = '203.0.113.50';

/** IPs for the rate-limit isolation test. */
const RL_IP = '203.0.113.60';
const RL_OTHER_IP = '203.0.113.61';

describe('Recovery flow — integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      canConnect = false;
    }
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Reset every relevant table so each test starts clean. CASCADE
    // handles incidental FK references; `admin_backup_codes` is included
    // because the recovery flow reads/writes it directly.
    await db.execute(
      sql`TRUNCATE TABLE login_attempts, audit_log, admin_backup_codes, system_state, settings, user_sites, sites, users RESTART IDENTITY CASCADE`,
    );
    // The recovery rate limiter is a module-level bucket map shared
    // across the whole process — clear it so a prior test's requests
    // don't count against this test's 3/IP/hour budget.
    __resetRecoveryRateLimitForTests();
  });

  /**
   * Build a Hono app mounting the PUBLIC `recoveryRouter` at
   * `/api/v1/admin/security` (mirroring `index.ts`). A leading
   * middleware pins the test `db` + `requestId` on the context and
   * injects a fresh REAL `RecoveryService` (bound to the test db, with
   * the anti-timing delay stubbed to instant) via the
   * `recoveryServiceOverride` seam the router honours.
   *
   * The router applies its own `withDb()` internally; with the override
   * present it never constructs a service from `c.get('db')`, but
   * `withDb()` still runs, so the `app.request` env (below) supplies
   * `LUMIBASE_ENV=development` + the test `DATABASE_URL` to keep it on
   * its lazy dev branch.
   */
  function buildApp(): Hono<AppEnv> {
    // One real, no-delay service per app — `db` is stable for the test.
    const service = new RecoveryService({
      db,
      sleep: () => Promise.resolve(),
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('requestId', `req_test_${Math.random().toString(36).slice(2)}`);
      c.set('recoveryServiceOverride', service);
      await next();
    });
    app.route('/api/v1/admin/security', recoveryRouter);
    return app;
  }

  /**
   * Seed the bootstrap admin via the production `SetupService` so the
   * `users` row carries real hashes AND the eight backup-code hashes are
   * persisted into `admin_backup_codes` (task 10.2). Returns the user id
   * plus the eight PLAINTEXT codes — the recovery test needs a real
   * plaintext code that matches a persisted hash.
   */
  async function seedBootstrapAdmin(): Promise<{
    userId: string;
    backupCodes: readonly string[];
  }> {
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
    });
    const outcome = await svc.complete(
      {
        account: {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
        adminPath: ADMIN_PATH,
        policy: freshStandardPolicy(),
      },
      { requestId: 'req-seed', ip: RECOVER_IP, userAgent: 'vitest' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('seedBootstrapAdmin failed');
    expect(outcome.value.backupCodes).toHaveLength(8);
    return {
      userId: outcome.value.user.id,
      backupCodes: outcome.value.backupCodes,
    };
  }

  /** POST the public `/recover` endpoint with the given client IP. */
  async function postRecover(
    app: Hono<AppEnv>,
    body: { email: string; backupCode: string },
    ip: string,
  ): Promise<Response> {
    return app.request(
      '/api/v1/admin/security/recover',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify(body),
      },
      RECOVERY_ENV,
    );
  }

  /** POST the public `/forgot-path` endpoint with the given client IP. */
  async function postForgotPath(
    app: Hono<AppEnv>,
    body: { email: string },
    ip: string,
  ): Promise<Response> {
    return app.request(
      '/api/v1/admin/security/forgot-path',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify(body),
      },
      RECOVERY_ENV,
    );
  }

  // ── 1. Lock → recover → unlock + adminPath returned ─────────────────

  it('recovers a locked bootstrap admin with a backup code, returning adminPath + token and clearing the lockout (Req 14.4, Property 4)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const { userId, backupCodes } = await seedBootstrapAdmin();
    const app = buildApp();

    // Force a lockout WITHOUT driving the login path (the lockout-flow
    // suite already proves the login route locks). Set a future
    // `lockedUntil` + a non-zero `failedCount`, and insert a burst of
    // recent `fail` rows for the email/IP so there's an IP block to
    // clear. The recover flow must reset all of it.
    await db
      .update(users)
      .set({
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
        failedCount: 5,
        failedCountWindowStart: new Date(),
      })
      .where(eq(users.id, userId));

    await db.insert(loginAttempts).values(
      Array.from({ length: 4 }, () => ({
        emailLower: ADMIN_EMAIL.toLowerCase(),
        userId,
        ip: RECOVER_IP,
        result: 'fail' as const,
        reason: 'invalid_credentials',
      })),
    );

    // Sanity: the burst landed.
    const beforeFails = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, RECOVER_IP),
          eq(loginAttempts.result, 'fail'),
        ),
      );
    expect(beforeFails[0]?.count).toBe(4);

    // Recover with the FIRST real plaintext backup code.
    const code = backupCodes[0]!;
    const res = await postRecover(
      app,
      { email: ADMIN_EMAIL, backupCode: code },
      RECOVER_IP,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { adminPath?: string; oneTimeUnlockToken?: string };
    };
    expect(body.data?.adminPath).toBe(ADMIN_PATH);
    expect(typeof body.data?.oneTimeUnlockToken).toBe('string');
    expect((body.data?.oneTimeUnlockToken ?? '').length).toBeGreaterThan(0);

    // DB: exactly one code row is now spent, stamped with the request IP.
    const usedRows = await db
      .select({
        usedAt: adminBackupCodes.usedAt,
        usedFromIp: adminBackupCodes.usedFromIp,
      })
      .from(adminBackupCodes)
      .where(
        and(
          eq(adminBackupCodes.userId, userId),
          isNotNull(adminBackupCodes.usedAt),
        ),
      );
    expect(usedRows).toHaveLength(1);
    expect(usedRows[0]?.usedAt).toBeInstanceOf(Date);
    expect(usedRows[0]?.usedFromIp).toBe(RECOVER_IP);

    // The other seven codes remain spendable.
    const unusedCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminBackupCodes)
      .where(
        and(
          eq(adminBackupCodes.userId, userId),
          isNull(adminBackupCodes.usedAt),
        ),
      );
    expect(unusedCount[0]?.count).toBe(7);

    // DB: the user lockout cleared.
    const userRows = await db
      .select({
        lockedUntil: users.lockedUntil,
        failedCount: users.failedCount,
        failedCountWindowStart: users.failedCountWindowStart,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(userRows[0]?.lockedUntil).toBeNull();
    expect(userRows[0]?.failedCount).toBe(0);
    expect(userRows[0]?.failedCountWindowStart).toBeNull();

    // DB: the IP's recent failure burst was drained (the unblock).
    const afterFails = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, RECOVER_IP),
          eq(loginAttempts.result, 'fail'),
        ),
      );
    expect(afterFails[0]?.count).toBe(0);
  }, 15000);

  // ── 2. Backup code single-use ───────────────────────────────────────

  it('rejects a second redemption of the same backup code with 401 while a different unused code still works (Req 14.7, Property 4)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const { backupCodes } = await seedBootstrapAdmin();
    const app = buildApp();

    const firstCode = backupCodes[0]!;
    const secondCode = backupCodes[1]!;

    // First redemption of `firstCode` succeeds (request #1 from RL_IP).
    const firstRes = await postRecover(
      app,
      { email: ADMIN_EMAIL, backupCode: firstCode },
      RL_IP,
    );
    expect(firstRes.status).toBe(200);

    // Second redemption of the SAME code fails: its `used_at` is now set,
    // so it's no longer in the `WHERE used_at IS NULL` candidate set
    // (request #2 from RL_IP — still within the 3/hour budget).
    const replayRes = await postRecover(
      app,
      { email: ADMIN_EMAIL, backupCode: firstCode },
      RL_IP,
    );
    expect(replayRes.status).toBe(401);
    const replayBody = (await replayRes.json()) as {
      errors: { code: string }[];
    };
    expect(replayBody.errors[0]!.code).toBe('INVALID_BACKUP_CODE');

    // A DIFFERENT, still-unused code still works (request #3 from RL_IP).
    const secondRes = await postRecover(
      app,
      { email: ADMIN_EMAIL, backupCode: secondCode },
      RL_IP,
    );
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as {
      data?: { adminPath?: string };
    };
    expect(secondBody.data?.adminPath).toBe(ADMIN_PATH);
  }, 15000);

  // ── 3. Rate limit 3/IP/hour (shared across both endpoints) ──────────

  it('enforces a shared 3/IP/hour budget across /recover + /forgot-path and isolates per-IP (Req 14.8)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    await seedBootstrapAdmin();
    const app = buildApp();

    // Budget is 3 across BOTH endpoints. Mix them up to prove the
    // counter is shared, not per-endpoint.
    expect(RECOVERY_RATE_LIMIT).toBe(3);

    // #1 — /recover with a wrong code → 401 (allowed, in budget).
    const r1 = await postRecover(
      app,
      { email: ADMIN_EMAIL, backupCode: 'WRNG-CODE' },
      RL_IP,
    );
    expect(r1.status).toBe(401);

    // #2 — /forgot-path (known email) → 200 generic (allowed, in budget).
    const r2 = await postForgotPath(app, { email: ADMIN_EMAIL }, RL_IP);
    expect(r2.status).toBe(200);

    // #3 — /recover with a wrong code → 401 (allowed, last of the budget).
    const r3 = await postRecover(
      app,
      { email: ADMIN_EMAIL, backupCode: 'WRNG-COD2' },
      RL_IP,
    );
    expect(r3.status).toBe(401);

    // #4 — same IP, over budget → 429 RATE_LIMITED + positive Retry-After.
    const r4 = await postForgotPath(app, { email: ADMIN_EMAIL }, RL_IP);
    expect(r4.status).toBe(429);
    const retryAfter = r4.headers.get('retry-after');
    expect(retryAfter).toBeTruthy();
    expect(Number.parseInt(retryAfter ?? '0', 10)).toBeGreaterThan(0);
    const r4Body = (await r4.json()) as { errors: { code: string }[] };
    expect(r4Body.errors[0]!.code).toBe('RATE_LIMITED');

    // A DIFFERENT IP still has its own budget (per-IP isolation).
    const other = await postForgotPath(
      app,
      { email: ADMIN_EMAIL },
      RL_OTHER_IP,
    );
    expect(other.status).toBe(200);
  }, 15000);

  // ── 4. forgot-path always returns a generic 200 ────────────────────

  it('forgot-path returns a generic 200 for both a known and an unknown email (Req 14.5)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    await seedBootstrapAdmin();
    const app = buildApp();

    // Known bootstrap email (request #1 from RL_IP).
    const knownRes = await postForgotPath(app, { email: ADMIN_EMAIL }, RL_IP);
    expect(knownRes.status).toBe(200);
    const knownBody = (await knownRes.json()) as { data?: { sent?: boolean } };
    expect(knownBody.data?.sent).toBe(true);

    // Unknown email — identical generic response (request #2 from RL_IP,
    // still within the 3/hour budget).
    const unknownRes = await postForgotPath(
      app,
      { email: 'nobody@example.com' },
      RL_IP,
    );
    expect(unknownRes.status).toBe(200);
    const unknownBody = (await unknownRes.json()) as {
      data?: { sent?: boolean };
    };
    expect(unknownBody.data?.sent).toBe(true);
  }, 15000);
});

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Env bindings passed as `app.request`'s third arg. The recovery router
 * applies `withDb()` internally; `LUMIBASE_ENV=development` keeps it on
 * its lazy dev branch (a postgres client is built but no socket opens
 * until a query runs) and `DATABASE_URL` points it at the test database.
 * The injected `recoveryServiceOverride` means this resolved `db` is
 * never actually queried by the service — but `withDb()` must not 500.
 */
const RECOVERY_ENV = {
  LUMIBASE_ENV: 'development',
  DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://test:test@127.0.0.1:5432/test',
} as unknown as AppEnv['Bindings'];

/**
 * Mutable copy of the Standard preset (matches the lockout-flow test).
 *
 * `STANDARD_LOCKOUT_POLICY` is `Object.freeze`d and its `notifyChannels`
 * array is `readonly`; spreading alone keeps the readonly marker, so we
 * clone the channels array explicitly to make the result assignable to
 * the mutable {@link LockoutPolicy} shape `SetupService.complete` expects.
 */
function freshStandardPolicy(): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
  };
}
