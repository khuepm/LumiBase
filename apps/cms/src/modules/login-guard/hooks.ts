/**
 * Login Guard hooks — `onFailure` / `onSuccess` / anomaly-block (admin-
 * setup-wizard task 6.2 + 8.1; Req 7.1, 7.2, 7.4, 8.1, 8.2, 8.6, 12.2,
 * 12.3, 12.4; design §6.3, §8.5).
 *
 * The {@link loginGuardMiddleware} from task 6.1 only short-circuits
 * a request that's already locked or rate-limited. Once the request
 * survives that gate, the `/auth/login` handler still has to:
 *
 *   1. Record the attempt (success, failure, or anomaly-blocked) in
 *      `login_attempts` so the sliding-window counter (task 5.3)
 *      stays accurate (Req 7.1, 8.1) and the anomaly columns
 *      (`country_code`, `geo_lookup_status`, `anomaly_score`,
 *      `anomaly_triggered`, `baseline_warmup`) carry the detector
 *      outputs forward to the audit trail (Req 9.5, 12.2, 12.3 /
 *      design §3.4).
 *   2. On credential failure, recompute the per-user counter and flip
 *      `users.lockedUntil` once it reaches `userMaxFailedAttempts`
 *      (Req 7.2). Recompute the per-IP counter and surface a warning
 *      when it crosses `ipMaxFailedAttempts` — there is no separate
 *      `ip_blocks` table because the counter itself is the source of
 *      truth (Req 8.2 / design §6.4).
 *   3. On success, atomically:
 *        - insert the success row carrying the anomaly draft fields
 *          populated by `geoSubscore` / `deviceSubscore`;
 *        - reset `users.failedCount` to 0 and clear `users.lockedUntil`
 *          so the next request starts from a clean slate (Req 7.4);
 *        - fold the attempt into `login_baselines` via
 *          {@link updateBaseline} from task 7.5 so the next login's
 *          subscores see this attempt as "known" (Req 9.6, 10.5,
 *          11.6).
 *      All three operations must succeed or fail together — a partial
 *      commit would either leak an attempt with no baseline update
 *      (the next subscore would re-flag the same country/device) or a
 *      baseline update with no attempt row (the sliding-window counter
 *      gets confused). The success path therefore runs inside a
 *      single `db.transaction(...)`.
 *   4. On anomaly trigger with `anomalyAction='lock'` or
 *      `'require_mfa'` (Req 12.3 / 12.4 / design §8.5), insert a
 *      `result='fail'` row carrying `reason='anomaly_lock'` /
 *      `'mfa_required'` and `anomaly_triggered=true`; for `'lock'`
 *      *also* set `users.lockedUntil = now + userLockoutDurationSeconds`
 *      so the next attempt for that email sees 423 ACCOUNT_LOCKED via
 *      the LoginGuard middleware. Failed-count is **not** reset
 *      because the login did not succeed (Req 7.4).
 *
 * These four functions are kept out of the middleware and the route
 * handler so they can be unit-tested without spinning up a Hono
 * context, and so the anomaly detector (task 8.1) can graft
 * `onSuccess` with extra side effects (baseline updates, anomaly
 * score writes) without rewriting the call site.
 *
 * Email is normalised at the boundary (`lower(email).trim()`) so the
 * inserted row matches the `email_window_idx` and the counter SQL
 * keyed on `loginAttempts.emailLower`. The wider request flow's
 * normalisation lives in task 6.3 — the helper here is tolerant of
 * the caller having already normalised, in which case `trim` /
 * `toLowerCase` are no-ops.
 *
 * Validates: Requirements 7.1, 7.2, 7.4, 8.1, 8.2, 8.6, 12.2, 12.3,
 * 12.4 (design §6.3, §8.5).
 */

import { eq, sql } from 'drizzle-orm';
import { loginAttempts, users, type Database } from '@lumibase/database';

import { updateBaseline as defaultUpdateBaseline } from '../anomaly/baseline-store';
import type { LoginAttemptDraft } from '../anomaly/types';
import type { LockoutPolicy } from '../setup/policy-codec';
import type { CounterStore } from './counter';
import { normalizeEmail } from './email-normalize';

// ── Public types ───────────────────────────────────────────────────────

export interface LoginFailureContext {
  /** Caller-supplied email; normalised internally. */
  readonly email: string;
  /** Resolved client IP per `extractClientIp`. */
  readonly ip: string;
  /** Free-form reason; one of `invalid_credentials | account_locked | ip_blocked | anomaly_lock | mfa_required`. */
  readonly reason: string;
  readonly userAgent?: string | null;
  /**
   * Resolved user id when the email matched a row, otherwise `null`.
   * Stored verbatim into `loginAttempts.userId` so historical
   * attempts stay queryable per user.
   */
  readonly userId?: string | null;
}

export interface LoginSuccessContext {
  readonly userId: string;
  readonly email: string;
  readonly ip: string;
  readonly userAgent?: string | null;
  /**
   * Anomaly draft populated by `geoSubscore` / `deviceSubscore`
   * earlier in the request lifecycle (task 7.2 / 7.4). The relevant
   * fields are:
   *   - `countryCode` — ISO-3166 alpha-2 from the GeoIP lookup; null
   *     when the geo detector skipped (private IP / lookup failure).
   *   - `geoLookupStatus` — `'ok' | 'unavailable' | 'timeout'`.
   *   - `deviceFingerprint` — 16-hex truncated SHA-256; null when UA
   *     was missing.
   *   - `deviceLookupStatus` — `'ok' | 'unavailable'`.
   * Each field is optional so legacy call sites that don't run the
   * detectors yet can still call the hook with the bare context.
   * The hook persists whatever subset is provided onto the
   * `login_attempts` row (Req 9.5, 12.2, 12.3 / design §3.4).
   */
  readonly attempt?: LoginAttemptDraft;
  /**
   * Aggregated anomaly score from {@link runDetectors} / {@link
   * aggregate}. Numeric value in `{0, 1}` per Req 12.1; the hook
   * stores its 2-decimal canonical form on `login_attempts
   * .anomaly_score`. Null when anomaly detection was skipped (e.g.
   * the policy disabled all three detectors and the route handler
   * chose not to run the aggregator).
   */
  readonly anomalyScore?: number | null;
  /**
   * `true` when the score crossed `Lockout_Policy.anomalyScoreThreshold`
   * AND `baselineWarmup === false` AND the policy chose
   * `anomalyAction='notify_only'` — i.e. the login was allowed but the
   * anomaly was recorded for audit + notification (Req 12.2). Defaults
   * to `false` when omitted.
   */
  readonly anomalyTriggered?: boolean;
  /**
   * `true` when *any* of the three subscores is still in baseline
   * warmup mode (Req 12.5). Stored on `login_attempts.baseline_warmup`
   * for forensic clarity even though the threshold dispatch already
   * gated on it. Defaults to `false` when omitted.
   */
  readonly baselineWarmup?: boolean;
}

/**
 * Context for the anomaly-block path (task 8.1; Req 12.3, 12.4 /
 * design §8.5). Mirrors {@link LoginSuccessContext} because the
 * detectors run with the user *already authenticated* (correct
 * password verified) and the only signal we want to propagate is the
 * anomaly verdict — credentials are deliberately re-described as a
 * "fail" row so the sliding-window counter sees the rejection and
 * the audit trail captures the reason.
 */
export interface AnomalyBlockContext {
  readonly userId: string;
  readonly email: string;
  readonly ip: string;
  readonly userAgent?: string | null;
  readonly attempt?: LoginAttemptDraft;
  readonly anomalyScore: number;
  readonly baselineWarmup: boolean;
  /**
   * `'lock'` → 423 ANOMALY_LOCK + `users.lockedUntil` is bumped here.
   * `'require_mfa'` → 401 MFA_REQUIRED, no lockout side effect; the
   *   row's `reason` becomes `'mfa_required'` so the audit log can
   *   tell the two branches apart even though both reject the JWT
   *   issuance.
   * Note: the legacy `'notify_only'` action does NOT call this hook
   * — it goes through {@link recordLoginSuccess} with
   * `anomalyTriggered=true` instead, because the request was allowed
   * to proceed (Req 12.2).
   */
  readonly action: 'lock' | 'require_mfa';
}

export interface LoginFailureOutcome {
  /** True when the per-user counter ≥ `userMaxFailedAttempts` and `users.lockedUntil` was set. */
  readonly userLocked: boolean;
  /** True when the per-IP counter ≥ `ipMaxFailedAttempts` (≥3 floor). Audit-only — no DB row written. */
  readonly ipBlocked: boolean;
  /** Counter value observed *after* this attempt was recorded (Req 7.1 / 8.1). */
  readonly userFailedCount: number;
  /** Counter value observed *after* this attempt was recorded (Req 8.1). */
  readonly ipFailedCount: number;
}

// ── Hooks ──────────────────────────────────────────────────────────────

/**
 * Record a failed login attempt and apply lockout side effects.
 *
 * Order of operations (matters):
 *
 *   1. Insert a `result='fail'` row into `login_attempts` *first* so
 *      the sliding-window counter (which reads `login_attempts`
 *      directly per design §6.4) sees this attempt. If we reversed
 *      the order, `userFailedCount` would be off-by-one and the
 *      lockout transition would never trigger on the threshold-th
 *      failure.
 *
 *   2. Recompute `userFailedCount(emailLower, lockoutWindowSeconds)`
 *      from the counter store. We don't trust the in-row
 *      `users.failedCount` integer because the spec's Standard preset
 *      can change `lockoutWindowSeconds` at runtime, and the integer
 *      doesn't know about windows. The counter store is the canonical
 *      source.
 *
 *   3. If `userFailedCount >= userMaxFailedAttempts`, set
 *      `users.lockedUntil = now() + userLockoutDurationSeconds` via
 *      `lower(email) = ?` so the update finds the row regardless of
 *      stored case (matches the design §3.1
 *      `users_email_lower_unique` index). We also write
 *      `users.failedCount = userFailedCount` so admin tooling can read
 *      the current counter at a glance — the integer is not the
 *      authority, but it's a useful denormalised mirror.
 *
 *   4. Recompute `ipFailedCount` and apply the Req 8.2 floor of 3.
 *      When the threshold is crossed we surface a `console.warn` so
 *      operators see the rate-limit kicking in — the actual block
 *      decision is made by the LoginGuard middleware on the *next*
 *      request, by reading the same counter (design §6.4). No new
 *      DB row is written for the block itself.
 *
 * @returns Counts and flags useful for caller-side audit/logging.
 *          The hook never throws on counter errors — a failed
 *          counter read returns 0 and the caller still gets a 401.
 */
export async function recordLoginFailure(
  db: Database,
  counter: CounterStore,
  policy: LockoutPolicy,
  ctx: LoginFailureContext,
  now: Date = new Date(),
): Promise<LoginFailureOutcome> {
  const emailLower = normalizeEmail(ctx.email);
  const ip = normaliseIp(ctx.ip);

  // 1. Insert the fail row. `userId` is `null` when the email didn't
  //    match any row — that's the standard "email-doesn't-exist"
  //    branch; the counter still correctly attributes it to the
  //    typed-in email so a brute-force loop on a single non-existent
  //    address still trips IP rate-limit.
  await db.insert(loginAttempts).values({
    emailLower,
    userId: ctx.userId ?? null,
    ip,
    userAgent: ctx.userAgent ?? null,
    result: 'fail',
    reason: ctx.reason,
  });

  // 2 + 3. Per-user threshold. Skip when the request didn't carry an
  //    email (or it was blank after normalisation) — the counter
  //    would key on an empty string and the lockout update would
  //    target zero rows, but issuing the SQL is wasteful.
  let userFailedCount = 0;
  let userLocked = false;
  if (emailLower.length > 0) {
    userFailedCount = await safeCount(() =>
      counter.userFailedCount(emailLower, policy.lockoutWindowSeconds),
    );

    if (userFailedCount >= policy.userMaxFailedAttempts) {
      const lockedUntil = new Date(
        now.getTime() + policy.userLockoutDurationSeconds * 1000,
      );
      // Use `lower(email) = ?` so the update matches a user whose row
      // stores the address with mixed case (the legacy /register
      // path doesn't normalise yet — task 6.3). Drizzle's
      // `.update(users).set(...).where(sql\`...\`)` builds the right
      // SQL here.
      await db
        .update(users)
        .set({
          lockedUntil,
          failedCount: userFailedCount,
        })
        .where(sql`lower(${users.email}) = ${emailLower}`);
      userLocked = true;
    }
  }

  // 4. Per-IP threshold (audit-only). Defend in depth against an
  //    operator-corrupted policy row by enforcing the Req 8.2 floor
  //    of 3, mirroring the same clamp used in the middleware.
  const ipFailedCount = await safeCount(() =>
    counter.ipFailedCount(ip, policy.lockoutWindowSeconds),
  );
  const ipThreshold = Math.max(3, policy.ipMaxFailedAttempts);
  const ipBlocked = ipFailedCount >= ipThreshold;
  if (ipBlocked) {
    // Phase E (task 9.5) wires NotificationDispatcher; Phase F
    // (task 11.2) wires AuditLogger. For now, surface the event via
    // the structured warn channel so operators tailing logs see it.
    // The follow-on tasks will replace this with a proper audit
    // entry without changing the caller contract.
    // eslint-disable-next-line no-console
    console.warn('[login-guard] IP rate-limit threshold reached', {
      ip,
      ipFailedCount,
      threshold: ipThreshold,
      lockoutWindowSeconds: policy.lockoutWindowSeconds,
    });
  }

  return { userLocked, ipBlocked, userFailedCount, ipFailedCount };
}

/**
 * Record a successful login attempt and reset the per-user counters.
 *
 * Order of operations (all inside a single transaction so a partial
 * failure doesn't leak a half-applied state across `login_attempts`,
 * `users`, and `login_baselines`):
 *
 *   1. Insert a `result='success'` row into `login_attempts`.
 *      The `reason` column stays null. Anomaly columns —
 *      `country_code`, `geo_lookup_status`, `anomaly_score`,
 *      `anomaly_triggered`, `baseline_warmup` — are populated from
 *      the {@link LoginSuccessContext.attempt} draft + the
 *      aggregator's verdict so the row is the single canonical
 *      record of what the detectors saw (Req 9.5, 12.2 / design
 *      §3.4).
 *
 *   2. Update the user row to clear lockout state:
 *      `failedCount=0`, `lockedUntil=null`,
 *      `failedCountWindowStart=null`. The integer counter columns
 *      are denormalised mirrors (the counter store is canonical),
 *      but resetting them keeps the row consistent with the "user
 *      is no longer in cooldown" reality (Req 7.4).
 *
 *   3. Fold the attempt into `login_baselines` via
 *      {@link updateBaseline}. The baseline writer is idempotent on
 *      missing rows (it issues an `INSERT ... ON CONFLICT DO
 *      NOTHING` first) so the very first successful login for a new
 *      user lands cleanly. Running inside the same transaction
 *      means a downstream rollback (e.g. an audit-log write fails)
 *      reverts both the attempt row and the baseline mutation —
 *      Property 3 (atomic setup) and the analogous "atomic login
 *      success" invariant from design §8.2 / §8.3 both rely on this.
 *
 * Note on reset scope: the spec only asks us to reset the user-level
 * counter on success (Req 7.4). The IP counter intentionally does
 * **not** reset — a single successful login on one account doesn't
 * absolve the IP from a credential-stuffing campaign across many
 * accounts. The IP counter naturally drains as old `fail` rows age
 * out of the sliding window.
 */
export async function recordLoginSuccess(
  db: Database,
  ctx: LoginSuccessContext,
  options: {
    /**
     * Override the baseline writer. Defaults to {@link defaultUpdateBaseline}.
     * Tests inject a stub so the success path can be exercised
     * without the full {@link updateBaseline} SQL machinery.
     */
    readonly updateBaseline?: typeof defaultUpdateBaseline;
    /**
     * Wall-clock used by the baseline writer (seeds `lastSeenAt` on
     * the device LRU and the histogram bucket index). Defaults to
     * `new Date()`. Tests pin this for determinism.
     */
    readonly now?: Date;
  } = {},
): Promise<void> {
  const emailLower = normalizeEmail(ctx.email);
  const ip = normaliseIp(ctx.ip);
  const draft = ctx.attempt ?? {};
  const now = options.now ?? new Date();
  const writeBaseline = options.updateBaseline ?? defaultUpdateBaseline;

  // Drizzle's `.transaction()` returns the callback result; we don't
  // need a return value but the shape gives us atomic rollback for
  // free. The callback receives a `tx` handle whose query interface
  // is identical to the parent `Database`, so the helpers below
  // (and the baseline writer) can be called without modification.
  await db.transaction(async (tx) => {
    await tx.insert(loginAttempts).values({
      emailLower,
      userId: ctx.userId,
      ip,
      userAgent: ctx.userAgent ?? null,
      countryCode: draft.countryCode ?? null,
      geoLookupStatus: draft.geoLookupStatus ?? null,
      result: 'success',
      reason: null,
      // `numeric` columns accept strings to preserve precision —
      // forming the canonical `'0.00'` / `'1.00'` string here keeps
      // the column round-tripping byte-equal regardless of the
      // driver's number-vs-string handling. `null` on omission so the
      // row makes it clear the detector was skipped vs. simply
      // returned 0.
      anomalyScore:
        ctx.anomalyScore == null ? null : ctx.anomalyScore.toFixed(2),
      anomalyTriggered: ctx.anomalyTriggered ?? false,
      baselineWarmup: ctx.baselineWarmup ?? false,
    });

    // Reset by primary key — `userId` is authoritative because the
    // caller has just verified the password against this exact row.
    // We don't re-key on email here so a future case-mutation of the
    // email column can't accidentally split the reset across rows.
    await tx
      .update(users)
      .set({
        failedCount: 0,
        lockedUntil: null,
        failedCountWindowStart: null,
      })
      .where(eq(users.id, ctx.userId));

    // Fold the attempt into `login_baselines`. The writer takes its
    // own row-level lock (`SELECT ... FOR UPDATE`) so concurrent
    // successful logins for the same user serialise on the merge.
    // We pass the same `tx` handle so the lock + UPDATE pair shares
    // a transaction with the attempt insert above.
    await writeBaseline(tx as Database, ctx.userId, draft, now);
  });
}

/**
 * Record an anomaly-block: the user provided correct credentials but
 * the aggregated anomaly score crossed `Lockout_Policy
 * .anomalyScoreThreshold` AND `baselineWarmup === false` AND the
 * configured `anomalyAction` is `'lock'` or `'require_mfa'`
 * (Req 12.3 / 12.4 / design §8.5).
 *
 * Side effects:
 *
 *   1. Insert a `result='fail'` row into `login_attempts` carrying
 *      the anomaly draft + score + the appropriate `reason`
 *      (`'anomaly_lock'` for `'lock'`, `'mfa_required'` for
 *      `'require_mfa'`). `anomaly_triggered=true` so the row is
 *      easy to filter from the audit trail.
 *   2. **For `action='lock'` only**, set `users.lockedUntil = now +
 *      userLockoutDurationSeconds` so the next attempt for this email
 *      sees 423 ACCOUNT_LOCKED via the LoginGuard middleware (Req
 *      12.3). `failed_count` is left untouched — the credential check
 *      passed, so the per-attempt counter doesn't apply; the lockout
 *      is a separate decision driven by the anomaly verdict.
 *   3. **For `action='require_mfa'`**, no lockout is set. The route
 *      handler returns 401 MFA_REQUIRED so the client can re-attempt
 *      after stepping up (when MFA ships); the failed-count is
 *      likewise left alone.
 *
 * The function is intentionally NOT wrapped in a transaction: each
 * write is independent and the caller is responsible for surfacing a
 * partial failure as a 500. Wrapping in a transaction would create a
 * lock-ordering hazard with the LoginGuard middleware, which reads
 * `users.lockedUntil` for the next request — we want the
 * `users.lockedUntil` write to commit immediately so the very next
 * login attempt sees the lock.
 *
 * Validates: Requirements 12.2 (anomaly_triggered column), 12.3
 * (lock action), 12.4 (require_mfa action).
 */
export async function recordAnomalyBlock(
  db: Database,
  policy: LockoutPolicy,
  ctx: AnomalyBlockContext,
  now: Date = new Date(),
): Promise<void> {
  const emailLower = normalizeEmail(ctx.email);
  const ip = normaliseIp(ctx.ip);
  const draft = ctx.attempt ?? {};
  const reason =
    ctx.action === 'lock' ? 'anomaly_lock' : 'mfa_required';

  await db.insert(loginAttempts).values({
    emailLower,
    userId: ctx.userId,
    ip,
    userAgent: ctx.userAgent ?? null,
    countryCode: draft.countryCode ?? null,
    geoLookupStatus: draft.geoLookupStatus ?? null,
    result: 'fail',
    reason,
    anomalyScore: ctx.anomalyScore.toFixed(2),
    anomalyTriggered: true,
    baselineWarmup: ctx.baselineWarmup,
  });

  if (ctx.action === 'lock') {
    const lockedUntil = new Date(
      now.getTime() + policy.userLockoutDurationSeconds * 1000,
    );
    // Use `lower(email) = ?` so the update matches a user whose row
    // stores the address with mixed case — same convention as
    // `recordLoginFailure`. We don't bump `failedCount` because the
    // credential check passed; the lockout is purely the anomaly
    // verdict's response.
    await db
      .update(users)
      .set({ lockedUntil })
      .where(sql`lower(${users.email}) = ${emailLower}`);
  }
}

// ── Internal helpers ───────────────────────────────────────────────────

function normaliseIp(input: string | null | undefined): string {
  if (typeof input !== 'string') return 'unknown';
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

/**
 * Wrap a counter call so a transient DB hiccup doesn't bubble up out
 * of the hook. A failed read returns 0; the worst-case result is the
 * lockout transition is delayed by one request — vs. the caller
 * seeing a 500 because the counter blew up.
 */
async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[login-guard] counter read failed; treating as 0', err);
    return 0;
  }
}
