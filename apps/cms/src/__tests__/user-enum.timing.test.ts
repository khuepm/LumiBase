/**
 * Security / timing test for `/auth/login` user-enumeration parity
 * (admin-setup-wizard task 6.9).
 *
 * **Validates: Requirements 7.5**
 * **Validates: Property 8 — No-Enumeration on Login Fail (design.md §13.3)**
 *
 * Background
 * ----------
 * Req 7.5 mandates that the login response for an `INVALID_CREDENTIALS`
 * outcome must not reveal whether the supplied email actually exists
 * in the `users` table. "Indistinguishable" is a two-axis claim:
 *
 *   1. **Response body**: every 401 must be the *exact same bytes*.
 *      Different bytes (status codes embedded in JSON, hint strings,
 *      length variations) would let an attacker classify responses by
 *      `content-length` alone — exactly the leak the requirement
 *      forbids.
 *
 *   2. **Latency**: a probing bot must not be able to tell, by
 *      response time alone, whether the email it just tried hits an
 *      existing user (which runs PBKDF2 against `users.passwordHash`)
 *      or no user at all (which would naturally short-circuit if not
 *      paired with a dummy hash). Property 8 pins the bound at "p95
 *      delta ≤ 50 ms" between the two batches.
 *
 * The production code path the request takes is the
 * `apps/cms/src/routes/auth.ts` `POST /auth/login` handler. The
 * existing-email branch resolves the user, then runs
 * `verifyPassword(plaintext, user.passwordHash)`. The missing-email
 * branch runs `verifyPassword(plaintext, getDummyPasswordHash())`
 * against a freshly minted PBKDF2 hash that the user could never
 * produce. Both branches therefore pay one PBKDF2-SHA256 derivation
 * (~100ms with 100k iterations on a developer laptop), and both end
 * with the same `c.json({ errors: [{ code: 'INVALID_CREDENTIALS', ...
 * }] }, 401)` shape.
 *
 * Approach
 * --------
 * Following the playbook from `path-compare.timing.test.ts` and
 * `404-indistinguishable.test.ts`:
 *
 *   - **Real `authRouter`**: we mount the production router so the
 *     `loginGuardMiddleware` precheck, the `recordLoginFailure` hook,
 *     the `users` SELECT, and the `verifyPassword` call all run end-
 *     to-end against Postgres. A pure-mock harness would prove
 *     nothing about the deployed surface.
 *
 *   - **Real Postgres**: we follow the same `DATABASE_URL`-driven
 *     skip pattern as `setup-flow.integration.test.ts` and
 *     `lockout-flow.integration.test.ts`, so local-only `pnpm test`
 *     stays green when no database is reachable while CI with a DB
 *     enforces the bound.
 *
 *   - **State reset between requests**: `recordLoginFailure` writes a
 *     `result='fail'` row to `login_attempts` on every attempt. After
 *     5 fails the LoginGuard middleware short-circuits the next
 *     attempt with 423 ACCOUNT_LOCKED — that branch skips
 *     `verifyPassword` entirely and is ~100x faster than the timed
 *     branch we want to measure. Same for IP rate-limit at 20 fails
 *     (Standard preset). To keep every request on the password-verify
 *     code path, we wipe `login_attempts` and reset
 *     `users.lockedUntil` before each timed call. The reset SQL runs
 *     *outside* the timed window, so it doesn't pollute the latency
 *     measurement; both scenarios pay the same reset cost so any
 *     per-call cost cancels out in the delta.
 *
 *   - **Warmup**: a few hundred untimed requests per scenario to
 *     settle V8's JIT tier-up into TurboFan, prime the connection
 *     pool, and amortise PBKDF2 first-call overhead. Without this,
 *     the first batch of timed samples is systematically slower.
 *
 *   - **Interleaving**: outer iterations alternate scenario order to
 *     spread any thermal / GC drift evenly across both samples
 *     instead of letting it concentrate in one.
 *
 *   - **p95 quantile**: Property 8 explicitly bounds p95, which
 *     catches tail-heavy leaks that arithmetic means smooth out.
 *     Sorted-array indexing at the 0.95 quantile is the standard
 *     definition.
 *
 * Tolerance
 * ---------
 * The 50ms p95-delta bound from Req 7.5 / Property 8 is generous on
 * purpose: PBKDF2-SHA256 100k iterations runs in 50–150 ms on most
 * machines, and that variance is itself larger than the leak we want
 * to detect. 50ms acts as a "gross leak" gate that catches an
 * accidental fast-path regression (e.g. forgetting `getDummyPasswordHash`
 * on the missing-email branch and returning early without any work)
 * while staying robust against CI GC pauses, noisy-neighbour
 * scheduling jitter, and connection-pool warm-up effects.
 *
 * Runtime budget
 * --------------
 * 2 × 500 timed requests + warmup + per-request reset round-trips
 * each take ≈ 100ms (dominated by PBKDF2). On a developer laptop
 * this finishes in a few minutes; the timeout below is set
 * generously to absorb CI noise.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createDb,
  type Database,
} from '@lumibase/database';

import type { AppEnv } from '../env';
import { authRouter } from '../routes/auth';
import { SetupService } from '../modules/setup/service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../modules/setup/policy-codec';

// PBKDF2 verifies dominate runtime; budget generously for CI.
vi.setConfig({ testTimeout: 600_000 });

// ── Tunables ────────────────────────────────────────────────────────────

/** Timed requests per scenario (per task: 500). */
const SAMPLES = 500;

/**
 * Untimed warmup requests per scenario before measurement begins.
 * Smaller than path-compare's 2k because each request here pays a
 * full PBKDF2 cycle; a few hundred is enough to settle the JIT and
 * connection pool without doubling the test runtime.
 */
const WARMUP = 50;

/** p95 latency delta bound (ms). Pinned by Req 7.5 / Property 8. */
const P95_DELTA_BOUND_MS = 50;

/** Bootstrap admin credentials seeded once per test run. */
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple!42';

/** Wrong password used by every fail attempt across both scenarios. */
const WRONG_PASSWORD = 'definitely-not-the-real-password';

/** Single client IP for both scenarios; per-IP counter is reset between. */
const TEST_CLIENT_IP = '203.0.113.55';

/** JWT secret injected on `c.env`; never used because every request fails. */
const JWT_SECRET = 'test-secret-do-not-use-in-prod';

/**
 * Canonical envelope every fail response must carry. Computed once
 * and asserted byte-equal against every response body — both inside
 * the timed loop (cheap) and at sanity-probe time (richer error
 * message).
 */
const EXPECTED_BODY = JSON.stringify({
  errors: [
    {
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
    },
  ],
});

// ── Test ────────────────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.DATABASE_URL;

describe('auth/login — no user-enumeration timing parity (Property 8)', () => {
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
    // slate. CASCADE handles incidental FK references the same way
    // the lockout-flow integration test does.
    await db.execute(
      sql`TRUNCATE TABLE lumibase_login_attempts, lumibase_audit_log, lumibase_system_state, lumibase_settings, lumibase_user_sites, lumibase_sites, lumibase_users RESTART IDENTITY CASCADE`,
    );
  });

  /**
   * Build a Hono app that mounts only the production `authRouter` and
   * pins the per-request DB on the context. Same wiring as the
   * lockout-flow integration test — we deliberately skip
   * `withTenant`/`withAuth`/`withRuntime` because `/auth/login`
   * doesn't read any of those, and adding them would only inflate
   * per-request latency variance.
   */
  function buildApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set(
        'requestId',
        `req_test_${Math.random().toString(36).slice(2)}`,
      );
      await next();
    });
    app.route('/auth', authRouter);
    return app;
  }

  /**
   * Seed the bootstrap admin via the production `SetupService` so the
   * `users` row carries a real PBKDF2 hash (matching what the login
   * handler verifies against). Returns the user id so the per-call
   * reset can target the row by primary key.
   */
  async function seedBootstrapAdmin(): Promise<string> {
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false, encryptionAvailable: true,
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
      {
        requestId: 'req-seed',
        ip: TEST_CLIENT_IP,
        userAgent: 'vitest',
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('seedBootstrapAdmin failed');
    return outcome.value.user.id;
  }

  /**
   * Wipe `login_attempts` and clear any lockout/IP counter state so
   * the *next* timed request takes the full password-verify code path
   * (no 423/429 short-circuit). Runs before each timed call — outside
   * the timing window, so its cost doesn't pollute the measurement.
   *
   * `DELETE FROM lumibase_login_attempts` is preferred over `TRUNCATE` here
   * because the table is tiny (≤ a few rows between resets) and
   * `DELETE` doesn't take an exclusive lock that could serialise
   * neighbouring queries; the clamp on `users.lockedUntil` is the
   * critical part.
   */
  async function resetGuardState(): Promise<void> {
    await db.execute(sql`DELETE FROM lumibase_login_attempts`);
    await db.execute(
      sql`UPDATE lumibase_users SET locked_until = NULL, failed_count = 0, failed_count_window_start = NULL`,
    );
  }

  /**
   * Drive the production `/auth/login` route with a wrong password.
   * Both scenarios funnel through this helper so any framing
   * differences (header casing, body encoding) are eliminated as a
   * source of timing variance.
   */
  async function postLogin(
    app: Hono<AppEnv>,
    email: string,
  ): Promise<Response> {
    return app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': TEST_CLIENT_IP,
        },
        body: JSON.stringify({ email, password: WRONG_PASSWORD }),
      },
      // Third arg is the Hono Bindings — exposes JWT_SECRET on c.env
      // even though every request returns 401 before the JWT path
      // runs.
      { JWT_SECRET } as AppEnv['Bindings'],
    );
  }

  /**
   * Generate a fresh non-existent email per call. Random suffix keeps
   * the email lower-cased (so the LoginGuard's `lower(email) = $1`
   * lookup hits the missing-row branch), and the prefix `noenum-`
   * makes accidental collisions with seeded users impossible to
   * confuse with intent in the audit log.
   */
  function makeRandomEmail(): string {
    return `noenum-${Math.random().toString(36).slice(2, 12)}@example.com`;
  }

  it('500 fail logins (existing vs random email) — body byte-equal, p95 latency Δ ≤ 50ms', async () => {
    if (!canConnect) {
      console.warn(
        'Skipping: DATABASE_URL not set or database not reachable',
      );
      return;
    }

    await seedBootstrapAdmin();
    const app = buildApp();

    // ── Sanity: both scenarios genuinely produce the canonical 401
    //    envelope. If this pre-flight diverges, the timing
    //    measurement that follows is measuring a different code path
    //    on each side and the bound becomes meaningless. Catch the
    //    divergence loudly first.
    await resetGuardState();
    const existingProbe = await postLogin(app, ADMIN_EMAIL);
    expect(existingProbe.status).toBe(401);
    const existingProbeBytes = await readBytes(existingProbe);
    const existingProbeText = new TextDecoder().decode(existingProbeBytes);
    expect(existingProbeText).toBe(EXPECTED_BODY);

    await resetGuardState();
    const randomProbe = await postLogin(app, makeRandomEmail());
    expect(randomProbe.status).toBe(401);
    const randomProbeBytes = await readBytes(randomProbe);
    const randomProbeText = new TextDecoder().decode(randomProbeBytes);
    expect(randomProbeText).toBe(EXPECTED_BODY);
    expect(bytesEqual(existingProbeBytes, randomProbeBytes)).toBe(true);

    const referenceBytes = existingProbeBytes;

    // ── Warmup ──────────────────────────────────────────────────────
    // Touch both scenarios so the JIT specialises the request
    // pipeline for both inputs equally and the connection pool is
    // warm before any timed sample lands.
    for (let i = 0; i < WARMUP; i++) {
      await resetGuardState();
      await postLogin(app, ADMIN_EMAIL);
      await resetGuardState();
      await postLogin(app, makeRandomEmail());
    }

    // ── Timed loop ──────────────────────────────────────────────────
    // Pre-allocate so mid-run array resizing is not part of the
    // measurement.
    const existingLatencies: number[] = new Array(SAMPLES);
    const randomLatencies: number[] = new Array(SAMPLES);

    for (let s = 0; s < SAMPLES; s++) {
      // Interleave order across iterations so any first-vs-second-of-
      // the-pair effects (PG row cache warming, V8 inline-cache
      // tier-up between the two adjacent calls) and any monotonic
      // thermal / GC drift over the run affect both scenarios
      // symmetrically rather than landing entirely in one bucket.
      if ((s & 1) === 0) {
        // Existing-email first, random second.
        await resetGuardState();
        const t0 = performance.now();
        const r = await postLogin(app, ADMIN_EMAIL);
        existingLatencies[s] = performance.now() - t0;
        await assertCanonical401(r, referenceBytes, 'existing', s);

        await resetGuardState();
        const t1 = performance.now();
        const r2 = await postLogin(app, makeRandomEmail());
        randomLatencies[s] = performance.now() - t1;
        await assertCanonical401(r2, referenceBytes, 'random', s);
      } else {
        // Random first, existing second.
        await resetGuardState();
        const t0 = performance.now();
        const r = await postLogin(app, makeRandomEmail());
        randomLatencies[s] = performance.now() - t0;
        await assertCanonical401(r, referenceBytes, 'random', s);

        await resetGuardState();
        const t1 = performance.now();
        const r2 = await postLogin(app, ADMIN_EMAIL);
        existingLatencies[s] = performance.now() - t1;
        await assertCanonical401(r2, referenceBytes, 'existing', s);
      }
    }

    const existingP95 = quantile(existingLatencies, 0.95);
    const randomP95 = quantile(randomLatencies, 0.95);
    const p95Delta = Math.abs(existingP95 - randomP95);

    // Surface the numbers in the test output for easier triage of
    // future flakes.
    // eslint-disable-next-line no-console
    console.info(
      '[user-enum.timing] existing p95 (ms) =',
      existingP95.toFixed(3),
    );
    // eslint-disable-next-line no-console
    console.info(
      '[user-enum.timing] random   p95 (ms) =',
      randomP95.toFixed(3),
    );
    // eslint-disable-next-line no-console
    console.info(
      '[user-enum.timing] |Δ p95|  (ms) =',
      p95Delta.toFixed(3),
    );

    expect(p95Delta).toBeLessThanOrEqual(P95_DELTA_BOUND_MS);
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
 * shape that `SetupService.complete` expects.
 */
function freshStandardPolicy(): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
  };
}

/**
 * Pull the response body as a raw `Uint8Array` so byte-equality is
 * meaningful. `await res.text()` would stringify and lose any
 * encoding-level divergence (BOMs, zero-width chars), and `.json()`
 * would normalise key order.
 */
async function readBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Compare two `Uint8Array`s for byte equality. We don't reach for
 * `Buffer.equals` so the test works under both Node and Workers test
 * runners.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Inline byte-level + status assertion used inside the timed loop.
 * Wrapping it in a helper keeps the per-sample loop body small and
 * makes the failure messages consistent across both scenarios.
 *
 * Spot-check inside the loop: if a bug only manifests intermittently
 * (e.g. a rare branch returning a slightly different envelope, or a
 * missing header that masks a 503 as a "401" with extra body bytes),
 * we want to fail the test on the very request that diverges, not
 * after aggregating 500 samples and only looking at the body once.
 */
async function assertCanonical401(
  res: Response,
  referenceBytes: Uint8Array,
  label: 'existing' | 'random',
  sampleIndex: number,
): Promise<void> {
  const bytes = await readBytes(res);
  if (res.status !== 401 || !bytesEqual(bytes, referenceBytes)) {
    expect.fail(
      `${label}-email response diverged at sample ${sampleIndex}: status=${res.status}, body=${new TextDecoder().decode(bytes)}`,
    );
  }
}

/**
 * p-th quantile by linear interpolation on a sorted copy of `samples`.
 * For p=0.95 with N=500 the index lands at 474.05 → between samples
 * 474 and 475 (0-indexed), interpolated. Uses the standard
 * inclusive-percentile formula (`(n - 1) * p`).
 */
function quantile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  if (lo === hi) return loVal;
  const w = pos - lo;
  return loVal * (1 - w) + hiVal * w;
}
