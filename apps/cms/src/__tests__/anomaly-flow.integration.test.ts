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
  loginBaselines,
  settings,
  sites,
  users,
  type Database,
} from '@lumibase/database';

import type { AppEnv } from '../env';
import { authRouter } from '../routes/auth';
import { SetupService } from '../modules/setup/service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../modules/setup/policy-codec';
import {
  recordAnomalyBlock,
  recordLoginSuccess,
} from '../modules/login-guard/hooks';
import type { LoginAttemptDraft } from '../modules/anomaly/types';

/**
 * Integration tests for the anomaly-detection threshold-action flow
 * (admin-setup-wizard task 8.5; Req 12.2, 12.3, 12.5; design §13.2).
 *
 * The full /auth/login flow runs `geoSubscore` against the MaxMind
 * MMDB file, which CI containers don't ship — without it the geo
 * subscore degrades to `geoLookupStatus='unavailable'` and `value=0`
 * (Req 9.5), so a black-box `POST /auth/login` from a fake "US" IP
 * never trips the anomaly threshold even when the policy says it
 * should. To exercise the *anomaly verdict path* deterministically
 * we adopt the simpler shape called out in the task brief:
 *
 *   - Seed the bootstrap admin via the production `SetupService`
 *     (real PBKDF2 hash, real users row).
 *   - Persist the desired `Lockout_Policy` via the `settings` row
 *     keyed `login_security_policy` so `loadLockoutPolicyFromSettings`
 *     picks it up — same wiring `lockout-flow.integration.test.ts`
 *     uses for the IP-block scenario.
 *   - Pre-populate `login_baselines` with the desired
 *     `successfulLogins` + `countries` shape so the warmup gate
 *     (Req 9.4) and the country mismatch (Req 9.2) land where each
 *     scenario needs them.
 *   - Construct a synthetic `LoginAttemptDraft` carrying
 *     `countryCode='US'` + `geoLookupStatus='ok'` (the fields a
 *     working `geoSubscore` would have populated had the MMDB been
 *     present) and call `recordAnomalyBlock` / `recordLoginSuccess`
 *     directly — these are the same hooks the production
 *     `/auth/login` route invokes after the detector aggregator
 *     (`runDetectors`) returns its verdict, so the side effects we
 *     assert on (the `users.lockedUntil` bump, the `login_attempts`
 *     row with `anomaly_triggered=true`, the baseline merge) are
 *     byte-identical to the live request path.
 *
 * For the **lock from new country** scenario we also issue a real
 * `POST /auth/login` against the seeded admin afterwards so the
 * test demonstrates that the `users.lockedUntil` written by
 * `recordAnomalyBlock` is honoured by the `loginGuardMiddleware`
 * (423 ACCOUNT_LOCKED). That round-trip is what makes this an
 * integration test rather than a hooks unit test — it covers the
 * full chain: anomaly verdict → DB state → middleware short-circuit.
 *
 * Three scenarios:
 *
 *   1. **Lock from new country (Req 12.3)** — policy
 *      `anomalyAction='lock'`, `geoAnomalyEnabled=true`,
 *      `anomalyScoreThreshold=0.5`. Baseline `successfulLogins=3`,
 *      `countries=['VN']`. A login attempt from a US IP pushes
 *      `geoSubscore.value=1` → aggregated score `1.00` ≥ threshold
 *      `0.5` → `anomalyAction='lock'` fires →
 *      `recordAnomalyBlock(action='lock')` writes a `result='fail'`
 *      row with `reason='anomaly_lock'`, `anomaly_triggered=true`,
 *      `country_code='US'`, AND bumps `users.lockedUntil` past `now`.
 *      Subsequent `/auth/login` with the *correct* password returns
 *      423 ACCOUNT_LOCKED via the LoginGuard middleware.
 *
 *   2. **Warmup doesn't trigger lock (Req 12.5)** — same policy,
 *      same "new country" attempt, but baseline
 *      `successfulLogins=2` puts the geo subscore in warmup mode
 *      (Req 9.4: `successfulLogins<3`). The aggregator reports
 *      `baselineWarmup=true`, the route's `triggered = score >=
 *      threshold && !baselineWarmup` collapses to `false`, no
 *      anomaly block fires, the login proceeds via
 *      `recordLoginSuccess` with `anomalyTriggered=false`. Asserts:
 *      `users.lockedUntil` stays NULL; `login_attempts` records a
 *      `result='success'` row with `baseline_warmup=true`.
 *
 *   3. **Notify-only allows login (Req 12.2)** — same baseline as
 *      scenario 1 (`successfulLogins=3`, `countries=['VN']`) but
 *      policy `anomalyAction='notify_only'`. The threshold trips,
 *      but the route's `notify_only` branch flows through
 *      `recordLoginSuccess` with `anomalyTriggered=true` so the
 *      login is allowed and the row is tagged for downstream audit
 *      / notification (Phase E). Asserts: `users.lockedUntil`
 *      stays NULL; `login_attempts` records a `result='success'`
 *      row with `anomaly_triggered=true`, `country_code='US'`,
 *      `anomaly_score='1.00'`.
 *
 * Uses the project's shared `DATABASE_URL` env var pattern: when
 * the variable is unset or the database isn't reachable the suite
 * skips with a warning so local-only `pnpm test` doesn't break.
 *
 * **Validates: Requirements 12.2, 12.3, 12.5**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

/** JWT_SECRET injected through `c.env` for the login handler. */
const JWT_SECRET = 'test-secret-do-not-use-in-prod';

/** Shared bootstrap admin credentials. */
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple!42';

/**
 * Public IP that maps to "US" in our synthetic attempt draft.
 * The actual byte value is irrelevant — we never run the real
 * GeoIP lookup; the country comes from the `LoginAttemptDraft`
 * the test constructs. Using a TEST-NET-2 (RFC 5737) address keeps
 * the choice obviously synthetic.
 */
const US_IP = '198.51.100.42';

describe('Anomaly flow — integration', () => {
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
    // Reset every relevant table so each test starts on a clean
    // slate. CASCADE handles incidental FK references (login_attempts
    // → users, login_baselines → users, settings → sites,
    // user_sites → users) so we don't have to enumerate every
    // dependent.
    await db.execute(
      sql`TRUNCATE TABLE lumibase_login_attempts, lumibase_login_baselines, lumibase_audit_log, lumibase_system_state, lumibase_settings, lumibase_user_sites, lumibase_sites, lumibase_users RESTART IDENTITY CASCADE`,
    );
  });

  /**
   * Build a Hono app that mounts only the production `authRouter`
   * and pins the per-request DB **and site** on the context. Same
   * skeleton the lockout-flow integration test uses (task 6.8), with
   * the same correction: the claim that "/auth/login doesn't read
   * siteId" went stale when the login handler gained a site-scoped
   * `user_sites` membership check, so an unset siteId reaches Drizzle
   * as `undefined` and the request 500s. `withAuth` still stays out —
   * login bypasses it in production too.
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
   * Seed the bootstrap admin via the production `SetupService` so
   * the `users` row carries a real PBKDF2 hash. Returns the user id
   * for downstream baseline / lookup operations.
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
      { requestId: 'req-seed', ip: '127.0.0.1', userAgent: 'vitest' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('seedBootstrapAdmin failed');
    return outcome.value.user.id;
  }

  /**
   * Persist the supplied `Lockout_Policy` into the `settings` row
   * keyed `login_security_policy` so `loadLockoutPolicyFromSettings`
   * (used by the LoginGuard middleware *and* the
   * `/auth/login` handler) picks it up. Mirrors the shape used by
   * `lockout-flow.integration.test.ts` — `settings.siteId` is
   * NOT NULL with FK to `sites`, so we insert a throw-away site
   * first.
   */
  async function installPolicy(policy: LockoutPolicy): Promise<void> {
    const siteRows = await db
      .insert(sites)
      .values({ name: 'anomaly-test-site' })
      .returning({ id: sites.id });
    const siteId = siteRows[0]!.id;
    await db.insert(settings).values({
      siteId,
      key: 'login_security_policy',
      value: policy,
    });
  }

  /**
   * Pre-seed the per-user `login_baselines` row with a known
   * `successfulLogins` + `countries` shape so the geo detector's
   * branches (warmup vs. mismatch) land where each test expects.
   * `hour_histogram` is left at the schema default `Array(24).fill(0)`
   * and `device_fingerprints` at `[]` — neither is consulted by the
   * tests in this file.
   */
  async function seedGeoBaseline(
    userId: string,
    successfulLogins: number,
    countries: ReadonlyArray<string>,
  ): Promise<void> {
    await db.insert(loginBaselines).values({
      userId,
      countries: [...countries],
      successfulLogins,
    });
  }

  /**
   * Drive the production `/auth/login` route. Mirrors the helper
   * from `lockout-flow.integration.test.ts` so the harness shape
   * is identical — `cf-connecting-ip` populates the `extractClientIp`
   * primary branch, the JWT_SECRET binding flows through `c.env`.
   */
  async function postLogin(
    app: Hono<AppEnv>,
    body: { email: string; password: string },
    ip: string = US_IP,
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
      { JWT_SECRET } as AppEnv['Bindings'],
    );
  }

  // ── 1. Lock from new country (Req 12.3) ─────────────────────────────

  it('locks user when login from new country with anomalyAction=lock and successfulLogins>=3 (Req 12.3)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const userId = await seedBootstrapAdmin();
    await installPolicy({
      ...freshStandardPolicy(),
      geoAnomalyEnabled: true,
      timeAnomalyEnabled: false,
      deviceAnomalyEnabled: false,
      anomalyScoreThreshold: 0.5,
      anomalyAction: 'lock',
    });
    // 3 historical logins from VN — past the warmup gate (Req 9.4
    // `successfulLogins>=3`), so a fresh attempt from US registers
    // as a country mismatch (Req 9.2) and the geo subscore lands
    // at value=1.
    await seedGeoBaseline(userId, 3, ['VN']);

    // Synthetic `LoginAttemptDraft` carrying the fields a working
    // `geoSubscore` would have populated had the MMDB been present
    // (CI containers don't ship the file). The hook persists these
    // verbatim onto the `login_attempts` row — same code path as
    // the live request.
    const attempt: LoginAttemptDraft = {
      countryCode: 'US',
      geoLookupStatus: 'ok',
      deviceFingerprint: null,
      deviceLookupStatus: 'unavailable',
    };

    const blockedAt = new Date();
    await recordAnomalyBlock(
      db,
      {
        ...freshStandardPolicy(),
        anomalyScoreThreshold: 0.5,
        anomalyAction: 'lock',
      },
      {
        userId,
        email: ADMIN_EMAIL,
        ip: US_IP,
        userAgent: 'vitest',
        attempt,
        anomalyScore: 1,
        baselineWarmup: false,
        action: 'lock',
      },
      blockedAt,
    );

    // ── DB-level assertions ──────────────────────────────────────────
    //
    // Req 12.3 — `users.lockedUntil` is set strictly in the future,
    // bounded above by `userLockoutDurationSeconds` from the policy
    // (default 900s for the Standard preset). Bound the comparison
    // so a clock skew or a flaky timer can't pass the assertion by
    // accident.
    const userRows = await db
      .select({
        lockedUntil: users.lockedUntil,
        failedCount: users.failedCount,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(userRows[0]?.lockedUntil).toBeInstanceOf(Date);
    expect(userRows[0]!.lockedUntil!.getTime()).toBeGreaterThan(
      blockedAt.getTime(),
    );
    expect(userRows[0]!.lockedUntil!.getTime()).toBeLessThanOrEqual(
      blockedAt.getTime() +
        STANDARD_LOCKOUT_POLICY.userLockoutDurationSeconds * 1000 +
        1000,
    );
    // Req 12.3 explicitly says the credential check passed — the
    // failed-count counter is *not* bumped on the anomaly path,
    // since the lockout is the verdict's response, not the
    // password verifier's.
    expect(userRows[0]!.failedCount).toBe(0);

    // Req 12.3 — `login_attempts` carries the anomaly verdict.
    const attemptRows = await db
      .select({
        result: loginAttempts.result,
        reason: loginAttempts.reason,
        anomalyScore: loginAttempts.anomalyScore,
        anomalyTriggered: loginAttempts.anomalyTriggered,
        baselineWarmup: loginAttempts.baselineWarmup,
        countryCode: loginAttempts.countryCode,
        geoLookupStatus: loginAttempts.geoLookupStatus,
      })
      .from(loginAttempts)
      .where(eq(loginAttempts.userId, userId));
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]!.result).toBe('fail');
    expect(attemptRows[0]!.reason).toBe('anomaly_lock');
    expect(attemptRows[0]!.anomalyTriggered).toBe(true);
    expect(attemptRows[0]!.baselineWarmup).toBe(false);
    expect(attemptRows[0]!.countryCode).toBe('US');
    expect(attemptRows[0]!.geoLookupStatus).toBe('ok');
    // `numeric(4,2)` round-trips as a string preserving the 2-decimal
    // precision (Property 9 / Req 12.1).
    expect(attemptRows[0]!.anomalyScore).toBe('1.00');

    // ── Middleware enforcement ──────────────────────────────────────
    //
    // The `users.lockedUntil` written above must short-circuit the
    // *next* `/auth/login` request via `loginGuardMiddleware`
    // (Req 7.3). This is what turns the test from a hooks unit
    // test into an integration test — the lock written by the
    // anomaly path is enforced by the same middleware that handles
    // the credential-failure lock.
    const app = buildApp(await seededSiteId());
    const lockedRes = await postLogin(app, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(lockedRes.status).toBe(423);
    const lockedBody = (await lockedRes.json()) as {
      errors: { code: string; retryAfterSeconds?: number }[];
    };
    expect(lockedBody.errors[0]!.code).toBe('ACCOUNT_LOCKED');
    expect(lockedBody.errors[0]!.retryAfterSeconds).toBeGreaterThan(0);
  });

  // ── 2. Warmup doesn't trigger lock (Req 12.5) ───────────────────────

  it('does not lock when login from new country happens during baseline warmup (Req 12.5)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const userId = await seedBootstrapAdmin();
    await installPolicy({
      ...freshStandardPolicy(),
      geoAnomalyEnabled: true,
      timeAnomalyEnabled: false,
      deviceAnomalyEnabled: false,
      anomalyScoreThreshold: 0.5,
      anomalyAction: 'lock',
    });
    // Only 2 historical logins — *below* the geo warmup gate
    // (Req 9.4: `successfulLogins<3` → `baselineWarmup=true`).
    // Even though the geo subscore would otherwise see a country
    // mismatch (US not in `['VN']`), the warmup flag short-circuits
    // the threshold-action dispatch (Req 12.5) and the login
    // proceeds normally.
    await seedGeoBaseline(userId, 2, ['VN']);

    // Synthetic draft mirrors what `geoSubscore` would have produced
    // in warmup mode: country resolved successfully, but the
    // detector's `baselineWarmup=true` means the route handler's
    // `triggered = score >= threshold && !baselineWarmup` collapses
    // to false → flow goes through `recordLoginSuccess`, NOT
    // `recordAnomalyBlock`.
    const attempt: LoginAttemptDraft = {
      countryCode: 'US',
      geoLookupStatus: 'ok',
      deviceFingerprint: null,
      deviceLookupStatus: 'unavailable',
    };

    await recordLoginSuccess(db, {
      userId,
      email: ADMIN_EMAIL,
      ip: US_IP,
      userAgent: 'vitest',
      attempt,
      // The aggregator's `score` is still 1 (the geo subscore
      // returned `value=0` due to warmup, but per the type the
      // aggregator may or may not run other axes; what matters is
      // the route's `triggered` decision uses `baselineWarmup`).
      // We pass score=0 to mirror what `runDetectors` returns when
      // every enabled axis is in warmup.
      anomalyScore: 0,
      anomalyTriggered: false,
      baselineWarmup: true,
    });

    // Req 12.5 — the user must not be locked.
    const userRows = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(userRows[0]!.lockedUntil).toBeNull();

    // The login attempt is recorded as a success with
    // `baseline_warmup=true` so audit/forensics can tell the
    // difference between "no anomaly seen" and "anomaly bypassed
    // by warmup".
    const attemptRows = await db
      .select({
        result: loginAttempts.result,
        anomalyTriggered: loginAttempts.anomalyTriggered,
        baselineWarmup: loginAttempts.baselineWarmup,
        countryCode: loginAttempts.countryCode,
      })
      .from(loginAttempts)
      .where(eq(loginAttempts.userId, userId));
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]!.result).toBe('success');
    expect(attemptRows[0]!.anomalyTriggered).toBe(false);
    expect(attemptRows[0]!.baselineWarmup).toBe(true);
    expect(attemptRows[0]!.countryCode).toBe('US');

    // The /auth/login endpoint should still allow a normal login —
    // the user is not locked. Use a non-private IP so the geo
    // subscore isn't auto-skipped by the private-IP guard, then
    // verify we get 200 and a JWT. The real geo subscore degrades
    // to `value=0` because there's no MMDB in the test container,
    // so the threshold isn't crossed even on this fresh request
    // and the login passes cleanly.
    const app = buildApp(await seededSiteId());
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
  });

  // ── 3. Notify-only allows login (Req 12.2) ──────────────────────────

  it('allows login but records anomaly_triggered=true when anomalyAction=notify_only (Req 12.2)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const userId = await seedBootstrapAdmin();
    await installPolicy({
      ...freshStandardPolicy(),
      geoAnomalyEnabled: true,
      timeAnomalyEnabled: false,
      deviceAnomalyEnabled: false,
      anomalyScoreThreshold: 0.5,
      anomalyAction: 'notify_only',
    });
    // Past the warmup gate — same shape as scenario 1.
    await seedGeoBaseline(userId, 3, ['VN']);

    const attempt: LoginAttemptDraft = {
      countryCode: 'US',
      geoLookupStatus: 'ok',
      deviceFingerprint: null,
      deviceLookupStatus: 'unavailable',
    };

    // Req 12.2 — `notify_only` means the login is *allowed* but
    // tagged. The route handler funnels this case through
    // `recordLoginSuccess` with `anomalyTriggered=true` so the
    // success row carries the verdict for downstream audit /
    // notification (Phase E task 9.5 wires the dispatcher).
    await recordLoginSuccess(db, {
      userId,
      email: ADMIN_EMAIL,
      ip: US_IP,
      userAgent: 'vitest',
      attempt,
      anomalyScore: 1,
      anomalyTriggered: true,
      baselineWarmup: false,
    });

    // The user must NOT be locked — `notify_only` is the explicit
    // "log it but let them in" branch (Req 12.2).
    const userRows = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(userRows[0]!.lockedUntil).toBeNull();

    // Req 12.2 — `login_attempts` carries the anomaly tag on a
    // success row, with the resolved country and 2-decimal score.
    const attemptRows = await db
      .select({
        result: loginAttempts.result,
        anomalyTriggered: loginAttempts.anomalyTriggered,
        baselineWarmup: loginAttempts.baselineWarmup,
        countryCode: loginAttempts.countryCode,
        geoLookupStatus: loginAttempts.geoLookupStatus,
        anomalyScore: loginAttempts.anomalyScore,
        reason: loginAttempts.reason,
      })
      .from(loginAttempts)
      .where(eq(loginAttempts.userId, userId));
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]!.result).toBe('success');
    expect(attemptRows[0]!.anomalyTriggered).toBe(true);
    expect(attemptRows[0]!.baselineWarmup).toBe(false);
    expect(attemptRows[0]!.countryCode).toBe('US');
    expect(attemptRows[0]!.geoLookupStatus).toBe('ok');
    expect(attemptRows[0]!.anomalyScore).toBe('1.00');
    expect(attemptRows[0]!.reason).toBeNull();

    // The success path also folds the new country into the
    // baseline (Req 9.6) — VN was already there, US gets appended,
    // `successfulLogins` increments to 4. This is the same writer
    // (`updateBaseline`) the production hook calls; asserting on
    // it pins the cross-module integration: anomaly verdict →
    // `recordLoginSuccess` → baseline merge.
    const baselineRows = await db
      .select({
        countries: loginBaselines.countries,
        successfulLogins: loginBaselines.successfulLogins,
      })
      .from(loginBaselines)
      .where(eq(loginBaselines.userId, userId))
      .limit(1);
    expect(baselineRows[0]?.successfulLogins).toBe(4);
    const countries = baselineRows[0]?.countries as string[];
    expect(countries).toContain('VN');
    expect(countries).toContain('US');
  });
});

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Mutable copy of the Standard preset.
 *
 * `STANDARD_LOCKOUT_POLICY` is `Object.freeze`d and its
 * `notifyChannels` array is `readonly`. Spreading on its own
 * preserves the readonly marker, so we clone the channels array
 * explicitly to make the result assignable to the mutable
 * {@link LockoutPolicy} shape that `recordAnomalyBlock` /
 * `recordLoginSuccess` and the `settings.value` insert expect.
 * Mirrors the helper in `lockout-flow.integration.test.ts`.
 */
function freshStandardPolicy(): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
  };
}
