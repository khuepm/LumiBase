import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createDb,
  loginAttempts,
  settings,
  sites,
  users,
  type Database,
} from '@lumibase/database';

import type { AppEnv } from '../env';
import { authRouter } from '../routes/auth';
import { SetupService } from '../modules/setup/service';
import { DEFAULT_SITE_ID } from '../modules/setup/site-constants';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../modules/setup/policy-codec';

/**
 * Integration tests for the LoginGuard lockout flow
 * (admin-setup-wizard task 6.8; Req 7.2-7.5, 8.2, 8.3; design §13.2).
 *
 * Three scenarios, all driven through the real `authRouter` so the
 * `loginGuardMiddleware` precheck, the `recordLoginFailure` /
 * `recordLoginSuccess` hooks, and the sliding-window counter run
 * end-to-end against Postgres:
 *
 *   1. **User lockout (Req 7.2, 7.3)** — five wrong-password attempts
 *      against a seeded bootstrap admin set `users.lockedUntil`; the
 *      next attempt (with either correct or wrong password) is
 *      short-circuited by the middleware with HTTP 423 ACCOUNT_LOCKED
 *      and a positive `retryAfterSeconds`.
 *
 *   2. **Counter reset on success (Req 7.4)** — after locking the
 *      user, manually rewind `users.lockedUntil` to a past timestamp
 *      to simulate the lockout duration having elapsed (the server's
 *      wall-clock advances naturally, but rewinding the deadline is a
 *      deterministic stand-in). A successful login then returns 200,
 *      `users.failedCount` resets to 0, and `users.lockedUntil`
 *      clears to NULL.
 *
 *   3. **IP block from multi-email (Req 8.2, 8.3)** — ten failed
 *      attempts from the same IP across distinct (and intentionally
 *      non-existent) emails should trip the IP rate-limit on the
 *      eleventh attempt with HTTP 429 IP_BLOCKED and a `Retry-After`
 *      header. The Standard preset's `ipMaxFailedAttempts` is 20, so
 *      the test installs a custom policy with `ipMaxFailedAttempts=10`
 *      via the `settings` table — `loadLockoutPolicyFromSettings`
 *      picks it up automatically. The user-side threshold is bumped
 *      to its ceiling (20) so the per-user lockout never fires first
 *      and the test cleanly isolates the IP path.
 *
 * Uses the project's shared `DATABASE_URL` env var pattern: when the
 * variable is unset or the database isn't reachable the suite skips
 * with a warning so local-only `pnpm test` doesn't break.
 *
 * **Validates: Requirements 7.2, 7.3, 7.4, 7.5, 8.2, 8.3**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

/** JWT_SECRET injected through `c.env` for the login handler. */
const JWT_SECRET = 'test-secret-do-not-use-in-prod';

/** Shared bootstrap admin credentials. */
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple!42';

/** Default IP used by the per-user lockout tests. */
const TEST_USER_IP = '203.0.113.7';

/** IP used by the multi-email rate-limit test. */
const TEST_BLOCK_IP = '203.0.113.99';

describe('Lockout flow — integration', () => {
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
    // Reset every relevant table so each test starts on a clean slate.
    // CASCADE handles incidental FK references (user_sites → users,
    // settings → sites, login_attempts → users) so we don't have to
    // enumerate every dependent.
    await db.execute(
      sql`TRUNCATE TABLE lumibase_login_attempts, lumibase_audit_log, lumibase_system_state, lumibase_settings, lumibase_user_sites, lumibase_sites, lumibase_users RESTART IDENTITY CASCADE`,
    );
  });

  /**
   * Build a Hono app that mounts only the production `authRouter` and
   * pins the per-request DB **and site** on the context. `withAuth` /
   * `withRuntime` stay out — `/auth/login` bypasses the former in
   * production, and the LoginGuard reads the DB via `c.get('db')`, the
   * policy via `loadLockoutPolicyFromSettings` and the counter via
   * `createCounterStore`, none of which need the runtime adapter.
   *
   * `siteId` is NOT optional, which is a correction: this harness used
   * to skip it on the stated grounds that "/auth/login doesn't read
   * c.get('siteId')". The login handler has since gained a
   * site-scoped `user_sites` membership check (`routes/auth.ts`), so an
   * unset siteId reaches Drizzle as `undefined` and the request 500s —
   * and `loadLockoutPolicyFromSettings` silently falls back to the
   * Standard preset, which is why a custom `ipMaxFailedAttempts` never
   * took effect. `withTenant` always sets it in production; the
   * harness has to as well.
   */
  function buildApp(siteId: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('requestId', `req_test_${Math.random().toString(36).slice(2)}`);
      await next();
    });
    app.route('/auth', authRouter);
    return app;
  }

  /** Site row `SetupService.complete` creates, read back rather than hardcoded. */
  async function seededSiteId(): Promise<string> {
    const [row] = await db.select({ id: sites.id }).from(sites).limit(1);
    if (!row) throw new Error('expected SetupService to have created a site');
    return row.id;
  }

  /**
   * Seed the bootstrap admin via the production `SetupService` so the
   * `users` row carries a real PBKDF2 hash (matching what the login
   * handler verifies against). Returns the user id for downstream
   * assertions.
   */
  async function seedBootstrapAdmin(): Promise<string> {
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
        adminPath: '/lumi-7f3a9c',
        policy: freshStandardPolicy(),
      },
      { requestId: 'req-seed', ip: TEST_USER_IP, userAgent: 'vitest' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('seedBootstrapAdmin failed');
    return outcome.value.user.id;
  }

  /** Drive the production `/auth/login` route. */
  async function postLogin(
    app: Hono<AppEnv>,
    body: { email: string; password: string },
    ip: string = TEST_USER_IP,
  ): Promise<Response> {
    return app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify(body),
      },
      // Third arg is the Hono Bindings — exposes JWT_SECRET on c.env.
      { JWT_SECRET } as AppEnv['Bindings'],
    );
  }

  // ── 1. User lockout ─────────────────────────────────────────────────

  it('locks user after 5 failed attempts and returns 423 ACCOUNT_LOCKED on subsequent attempts (Req 7.2, 7.3)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    await seedBootstrapAdmin();
    const app = buildApp(await seededSiteId());

    // Drive 5 wrong-password attempts. Each individual attempt
    // returns 401 INVALID_CREDENTIALS — the lock transition happens
    // inside `recordLoginFailure` on the 5th, but the response for
    // the 5th attempt is still 401 (the middleware precheck saw the
    // not-yet-locked state at the start of the request).
    for (let i = 0; i < 5; i++) {
      const res = await postLogin(app, {
        email: ADMIN_EMAIL,
        password: 'wrong-password',
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { errors: { code: string }[] };
      expect(body.errors[0]!.code).toBe('INVALID_CREDENTIALS');
    }

    // Verify the lock state landed in the DB after the 5th failure.
    const lockedRows = await db
      .select({ lockedUntil: users.lockedUntil, failedCount: users.failedCount })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);
    expect(lockedRows[0]?.lockedUntil).toBeInstanceOf(Date);
    expect(lockedRows[0]!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(lockedRows[0]?.failedCount).toBe(5);

    // 6th attempt — the middleware precheck now sees lockedUntil >
    // now() and short-circuits with 423 ACCOUNT_LOCKED + a positive
    // retryAfterSeconds.
    const lockedRes = await postLogin(app, {
      email: ADMIN_EMAIL,
      password: 'wrong-password',
    });
    expect(lockedRes.status).toBe(423);
    const lockedBody = (await lockedRes.json()) as {
      errors: { code: string; retryAfterSeconds?: number }[];
    };
    expect(lockedBody.errors[0]!.code).toBe('ACCOUNT_LOCKED');
    expect(lockedBody.errors[0]!.retryAfterSeconds).toBeGreaterThan(0);

    // Req 7.3: even with the *correct* password, the locked user is
    // still rejected with 423 — the lock applies to every attempt
    // against the email until the deadline passes.
    const correctPwdRes = await postLogin(app, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(correctPwdRes.status).toBe(423);
    const correctBody = (await correctPwdRes.json()) as {
      errors: { code: string }[];
    };
    expect(correctBody.errors[0]!.code).toBe('ACCOUNT_LOCKED');
  });

  // ── 2. Counter reset on success after lockout duration ─────────────

  it('successful login after lockout duration returns 200 and resets failedCount + lockedUntil (Req 7.4)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    await seedBootstrapAdmin();
    const app = buildApp(await seededSiteId());

    // Trip the lockout with 5 wrong-password attempts.
    for (let i = 0; i < 5; i++) {
      const res = await postLogin(app, {
        email: ADMIN_EMAIL,
        password: 'wrong-password',
      });
      expect(res.status).toBe(401);
    }

    // Confirm pre-condition: user is locked.
    const beforeRows = await db
      .select({ lockedUntil: users.lockedUntil, failedCount: users.failedCount })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);
    expect(beforeRows[0]?.lockedUntil).toBeInstanceOf(Date);
    expect(beforeRows[0]!.failedCount).toBe(5);

    // Time-warp: rewind `lockedUntil` to a past timestamp to simulate
    // the configured lockout duration (15 minutes default) having
    // elapsed. The middleware uses `lockedUntil > now()` so any past
    // value disables the lock.
    await db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.email, ADMIN_EMAIL));

    // Successful login — should return 200 with a JWT.
    const res = await postLogin(app, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { token?: string; user?: { email?: string } };
    };
    expect(typeof body.data?.token).toBe('string');
    expect(body.data?.user?.email).toBe(ADMIN_EMAIL);

    // Counter reset (Req 7.4): `failedCount` back to 0 and
    // `lockedUntil` cleared. The success row in `login_attempts` is
    // also written, but the user-row reset is the contract under test.
    const afterRows = await db
      .select({
        lockedUntil: users.lockedUntil,
        failedCount: users.failedCount,
        failedCountWindowStart: users.failedCountWindowStart,
      })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);
    expect(afterRows[0]?.failedCount).toBe(0);
    expect(afterRows[0]?.lockedUntil).toBeNull();
    expect(afterRows[0]?.failedCountWindowStart).toBeNull();

    // The success row exists in `login_attempts` so the counter sees
    // it (and so anomaly detection in Phase D has the artefact).
    const successRows = await db
      .select({ result: loginAttempts.result })
      .from(loginAttempts)
      .where(eq(loginAttempts.emailLower, ADMIN_EMAIL.toLowerCase()));
    expect(
      successRows.some((r) => r.result === 'success'),
    ).toBe(true);
  });

  // ── 3. IP block from multi-email ────────────────────────────────────

  /**
   * Un-skipped by the loader fix in the same change: the policy lookup is
   * now ordered, so the instance-wide row this test writes is the one in
   * force rather than whichever row Postgres returned first. See
   * `loadLockoutPolicyFromSettings` and the row-selection suite next to it.
   */
  it('blocks an IP after 10 failed attempts across different emails with 429 IP_BLOCKED (Req 8.2, 8.3)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // Seed the bootstrap admin so the schema's `users_is_bootstrap_unique`
    // partial index has a row to exclude — the failing logins target
    // distinct *non-existent* emails so this admin's lockout state is
    // untouched by the test.
    await seedBootstrapAdmin();

    // Install a custom Lockout_Policy with `ipMaxFailedAttempts=10`
    // (the task explicitly requires "10 fail từ một IP đa email"; the
    // Standard preset's default of 20 would slow the test without
    // exercising any new path). `userMaxFailedAttempts` is bumped to
    // its ceiling so per-user lockout doesn't fire on a typoed email
    // — the test must isolate the IP path.
    //
    // The Lockout_Policy is instance-wide and lives under the
    // `__default__` site, which `seedBootstrapAdmin()` above already
    // created along with a Standard-preset policy row (SetupService
    // §10). So this *overwrites* that row rather than adding a second
    // one — which is what an operator tightening the policy does, and
    // what the original version of this test got wrong: it wrote a
    // competing row under a throw-away site and relied on the loader
    // picking it, which `LIMIT 1` with no `ORDER BY` never guaranteed.
    const siteId = DEFAULT_SITE_ID;
    const customPolicy: LockoutPolicy = {
      ...freshStandardPolicy(),
      ipMaxFailedAttempts: 10,
      // userMaxFailedAttempts is in [3, 20]; bumping to 20 keeps the
      // per-user counter well below threshold no matter how many
      // distinct emails we hit.
      userMaxFailedAttempts: 20,
    };
    await db
      .insert(settings)
      .values({ siteId, key: 'login_security_policy', value: customPolicy })
      .onConflictDoUpdate({
        target: [settings.siteId, settings.key],
        set: { value: customPolicy },
      });

    // The request context carries the same site the policy row is scoped
    // to. Note this is NOT what selects the policy: the loader looks the
    // row up by `key` alone with `LIMIT 1` and no ORDER BY (design open
    // question 8 — siteId ownership of the settings row is unresolved),
    // so when a second `login_security_policy` row exists the row that
    // wins is whichever Postgres returns first. See the skip note below.
    const app = buildApp(siteId);

    // 10 wrong-password attempts from the same IP, each against a
    // distinct (non-existent) email. Each attempt returns 401
    // INVALID_CREDENTIALS — the IP counter increments inside
    // `recordLoginFailure` after the response is computed, so the
    // 10th attempt itself is *not* short-circuited (it hits the
    // existing-email no-enumeration branch and returns 401 like the
    // others).
    for (let i = 0; i < 10; i++) {
      const res = await postLogin(
        app,
        { email: `unknown${i}@example.com`, password: 'wrong-password' },
        TEST_BLOCK_IP,
      );
      expect(res.status).toBe(401);
    }

    // Sanity: 10 fail rows exist for the test IP.
    const ipFailCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        sql`${loginAttempts.ip} = ${TEST_BLOCK_IP} AND ${loginAttempts.result} = 'fail'`,
      );
    expect(ipFailCount[0]?.count).toBe(10);

    // 11th attempt from the same IP — the middleware precheck reads
    // `ipFailedCount(IP, lockoutWindowSeconds)` which now returns 10
    // (≥ ipMaxFailedAttempts), so it short-circuits with 429
    // IP_BLOCKED + the RFC 7231 `Retry-After` header (Req 8.3).
    const blockedRes = await postLogin(
      app,
      {
        email: 'one-more-different@example.com',
        password: 'whatever',
      },
      TEST_BLOCK_IP,
    );
    expect(blockedRes.status).toBe(429);
    const retryAfter = blockedRes.headers.get('retry-after');
    expect(retryAfter).toBeTruthy();
    expect(Number.parseInt(retryAfter ?? '0', 10)).toBeGreaterThan(0);

    const blockedBody = (await blockedRes.json()) as {
      errors: { code: string; retryAfterSeconds?: number }[];
    };
    expect(blockedBody.errors[0]!.code).toBe('IP_BLOCKED');
    expect(blockedBody.errors[0]!.retryAfterSeconds).toBeGreaterThan(0);

    // A request from a *different* IP must still go through (the
    // block is keyed per-IP, not global). It will fail authentication
    // — there's no real user — but the response code must be 401, not
    // 429: that's the cross-IP independence guarantee from Req 8.6.
    const otherIpRes = await postLogin(
      app,
      { email: 'still-unknown@example.com', password: 'wrong-password' },
      '198.51.100.1',
    );
    expect(otherIpRes.status).toBe(401);
  });
});

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Mutable copy of the Standard preset.
 *
 * `STANDARD_LOCKOUT_POLICY` is `Object.freeze`d and its
 * `notifyChannels` array is `readonly`. Spreading on its own preserves
 * the readonly marker, so we clone the channels array explicitly to
 * make the result assignable to the mutable {@link LockoutPolicy}
 * shape that `SetupService.complete` and `settings.value` expect.
 */
function freshStandardPolicy(): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
  };
}
