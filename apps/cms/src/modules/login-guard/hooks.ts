/**
 * Login Guard hooks — `onFailure` / `onSuccess` (admin-setup-wizard
 * task 6.2; Req 7.1, 7.2, 7.4, 8.1, 8.2, 8.6; design §6.3).
 *
 * The {@link loginGuardMiddleware} from task 6.1 only short-circuits
 * a request that's already locked or rate-limited. Once the request
 * survives that gate, the `/auth/login` handler still has to:
 *
 *   1. Record the attempt (success or failure) in `login_attempts` so
 *      the sliding-window counter (task 5.3) stays accurate (Req 7.1,
 *      8.1).
 *   2. On failure, recompute the per-user counter and flip
 *      `users.lockedUntil` once it reaches `userMaxFailedAttempts`
 *      (Req 7.2). Recompute the per-IP counter and surface a warning
 *      when it crosses `ipMaxFailedAttempts` — there is no separate
 *      `ip_blocks` table because the counter itself is the source of
 *      truth (Req 8.2 / design §6.4).
 *   3. On success, reset `users.failedCount` to 0 and clear
 *      `users.lockedUntil` so the next request starts from a clean
 *      slate (Req 7.4).
 *
 * These two functions are kept out of the middleware and the route
 * handler so they can be unit-tested without spinning up a Hono
 * context, and so anomaly detection (Phase D) can graft `onSuccess`
 * with extra side effects (baseline updates, anomaly score writes)
 * without rewriting the call site.
 *
 * Email is normalised at the boundary (`lower(email).trim()`) so the
 * inserted row matches the `email_window_idx` and the counter SQL
 * keyed on `loginAttempts.emailLower`. The wider request flow's
 * normalisation lives in task 6.3 — the helper here is tolerant of
 * the caller having already normalised, in which case `trim` /
 * `toLowerCase` are no-ops.
 *
 * Validates: Requirements 7.1, 7.2, 7.4, 8.1, 8.2, 8.6 (design §6.3).
 */

import { eq, sql } from 'drizzle-orm';
import { loginAttempts, users, type Database } from '@lumibase/database';

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
 * Order of operations:
 *
 *   1. Insert a `result='success'` row into `login_attempts`. The
 *     `reason` column stays null — we only populate it for failures
 *     and explicit blocks (`anomaly_lock`, `mfa_required` etc.).
 *
 *   2. Update the user row to clear lockout state:
 *      `failedCount=0`, `lockedUntil=null`,
 *      `failedCountWindowStart=null`. The integer counter columns
 *      are denormalised mirrors (the counter store is canonical),
 *      but resetting them keeps the row consistent with the "user
 *      is no longer in cooldown" reality.
 *
 * Phase D (task 8.1) will graft anomaly detection here: read
 * `login_baselines`, compute subscores, decide whether to mark the
 * attempt `anomaly_triggered`, and conditionally short-circuit. The
 * hook deliberately accepts the user id and email so the anomaly
 * detector can fan out without re-resolving the user.
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
): Promise<void> {
  const emailLower = normalizeEmail(ctx.email);
  const ip = normaliseIp(ctx.ip);

  await db.insert(loginAttempts).values({
    emailLower,
    userId: ctx.userId,
    ip,
    userAgent: ctx.userAgent ?? null,
    result: 'success',
    reason: null,
  });

  // Reset by primary key — `userId` is authoritative because the
  // caller has just verified the password against this exact row.
  // We don't re-key on email here so a future case-mutation of the
  // email column can't accidentally split the reset across rows.
  await db
    .update(users)
    .set({
      failedCount: 0,
      lockedUntil: null,
      failedCountWindowStart: null,
    })
    .where(eq(users.id, ctx.userId));
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
