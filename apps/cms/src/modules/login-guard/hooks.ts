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
// Type-only imports keep the dependency direction one-way: `login-guard`
// learns the dispatcher's *shape* without importing any of the
// notifications module's runtime code, so no import cycle forms (the
// notifications module never imports back into `login-guard`). See
// task 9.5 / Req 13.1.
import type { NotificationDispatcher } from '../notifications/dispatcher';
import type {
  NotificationChannel,
  NotificationPayload,
} from '../notifications/types';
// Type-only import keeps the dependency direction one-way, exactly like
// `NotificationDispatcher` above: the hooks learn the AuditLogger's
// *shape* (its `write()` method) without importing the logger's runtime
// code, so no import cycle forms and the existing hook unit tests can
// inject a tiny spy. The real `AuditLogger` instance is constructed in
// the route (`apps/cms/src/routes/auth.ts`) and threaded in. See task
// 11.2 / Req 15.1, 15.2.
import type { AuditLogger, AuditLogWriteInput } from '../audit/logger';
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

// ── Notification wiring (task 9.5; Req 13.1; design §6.3) ───────────────

/**
 * Optional notification dependencies threaded into each hook so the
 * LoginGuard can publish the four security events Req 13.1 enumerates
 * (`user_locked`, `ip_blocked`, `anomaly_triggered`, `anomaly_lock`)
 * to the operator's configured channels.
 *
 * The shape is a dependency-injection seam, **not** a singleton
 * import, for two reasons:
 *
 *   1. **Testability** — the existing hook unit tests
 *      (`__tests__/hooks.test.ts`) drive the hooks with a fake DB and
 *      counter and assert on the rows that *would* be written. A
 *      hard-wired dispatcher singleton would force those tests to
 *      stand up the real queue + channels. Injecting a spy keeps the
 *      hooks pure and the tests fast.
 *
 *   2. **Backward compatibility** — every field is optional. A call
 *      site that doesn't pass a `dispatcher` (the legacy `/register`
 *      flow, older tests, the setup transaction) sees dispatch
 *      collapse to a no-op, so wiring this in does not change any
 *      existing behaviour. Dispatch only happens when *both* a
 *      `dispatcher` is supplied **and** the resolved channel list is
 *      non-empty.
 *
 * The channel list is sourced from `Lockout_Policy.notifyChannels`.
 * `recordLoginFailure` and `recordAnomalyBlock` already receive the
 * `policy` so they read `policy.notifyChannels` directly;
 * `recordLoginSuccess` does not receive the policy, so its options
 * carry `notifyChannels` explicitly (the route resolves it from the
 * same policy instance).
 */
export interface NotificationDeps {
  /**
   * The dispatcher to publish to. When omitted, every dispatch in the
   * hook becomes a no-op — the hook still records the attempt and
   * applies lockout side effects exactly as before (Req 13.1 wiring
   * is additive).
   */
  readonly dispatcher?: NotificationDispatcher | null;
  /**
   * Channels to fan out to — `Lockout_Policy.notifyChannels`
   * (Req 13.1). Defaults to an empty list, which (like a missing
   * dispatcher) makes dispatch a no-op. `recordLoginFailure` /
   * `recordAnomalyBlock` ignore this field and read
   * `policy.notifyChannels` instead; it exists here primarily for
   * `recordLoginSuccess`, which has no policy in scope.
   */
  readonly notifyChannels?: readonly NotificationChannel[];
  /**
   * Audit logger for the Req 15.1 security events the hooks own
   * (`login_failed`, `login_success`, `user_locked`, `ip_blocked`,
   * `anomaly_triggered`) — admin-setup-wizard task 11.2.
   *
   * Folded into this same deps bundle (rather than a separate
   * parameter) so the route threads ONE object into every hook, exactly
   * as it does for the notification fields. Optional + injectable for
   * the SAME two reasons the dispatcher is (see above):
   *
   *   1. **Testability** — the hook unit tests drive a fake DB and
   *      assert on the rows that *would* be written; injecting a tiny
   *      spy `{ async write(e) { calls.push(e) } }` lets them assert
   *      the audit entries without standing up Postgres + the real
   *      logger.
   *   2. **Backward compatibility** — when omitted, {@link writeAudit}
   *      collapses to a no-op, so the existing `hooks.test.ts` /
   *      `hooks-notifications.test.ts` suites (which never pass an
   *      `audit`) keep passing unchanged. The audit write is purely
   *      additive.
   *
   * The route (`apps/cms/src/routes/auth.ts`) constructs a
   * `new AuditLogger({ db })` once per `/login` request and supplies it
   * here. `AuditLogger.write` is best-effort + never-throws (task
   * 11.1), so a failed audit write can never break the login flow.
   */
  readonly audit?: AuditLogger | null;
  /**
   * Correlation id for the audit entries the hooks write (the
   * `requestId` column — Req 15.2). The hooks have no Hono context, so
   * the route resolves `c.get('requestId')` (populated by the
   * `audit-context` middleware) and passes it through this bundle.
   * Optional — a missing id simply records the audit row with a null
   * `requestId`.
   */
  readonly requestId?: string;
}

/**
 * Write an audit entry through the injected {@link AuditLogger},
 * no-oping when none is wired. The AuditLogger's `write()` is itself
 * best-effort + never-throws (task 11.1), but we still wrap in a
 * try/catch as belt-and-brace so a throwing test spy (or a future
 * logger that breaks the contract) can NEVER fail the login flow —
 * exactly the guarantee {@link dispatchSecurityEvent} gives for
 * notifications (Req 13.4 spirit).
 *
 * Mirrors the `dispatchSecurityEvent` shape: takes the deps bundle and
 * the entry, skips entirely when no logger is present so the common
 * "audit not wired" path costs nothing.
 */
async function writeAudit(
  deps: NotificationDeps | undefined,
  entry: AuditLogWriteInput,
): Promise<void> {
  const audit = deps?.audit;
  if (!audit) return;
  try {
    await audit.write(entry);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[login-guard] audit write failed; login flow unaffected',
      err,
    );
  }
}

/**
 * The actor email for an audit entry derived from a login email:
 * the normalised address when present, `null` when blank (a probe with
 * an empty email has no meaningful actor — Req 15.2 allows a nullable
 * `actorEmail`).
 */
function actorEmailOrNull(emailLower: string): string | null {
  return emailLower.length > 0 ? emailLower : null;
}

/**
 * Fire-and-forget a notification through the injected dispatcher,
 * swallowing any synchronous throw or async rejection so a delivery
 * problem can NEVER break (or even delay) the login flow.
 *
 * Per design §6.3 / Req 13.4 the dispatch is **best-effort and
 * non-blocking**: even the serious `user_locked` / `anomaly_lock`
 * events must not fail the request if the queue / channel hiccups.
 * The dispatcher's own `dispatch()` only enqueues and resolves
 * immediately, so awaiting it here does not block on actual delivery
 * (which drains out-of-band on the worker tick — task 9.6 owns the
 * Workers drain path). We still belt-and-brace with a `.catch()` in
 * case a future dispatcher implementation throws synchronously while
 * building the task.
 *
 * The call is skipped entirely when no dispatcher is wired or no
 * channels are configured, so the common "notifications disabled"
 * path costs nothing.
 */
async function dispatchSecurityEvent(
  deps: NotificationDeps | undefined,
  channels: readonly NotificationChannel[],
  payload: NotificationPayload,
): Promise<void> {
  const dispatcher = deps?.dispatcher;
  if (!dispatcher) return;
  if (channels.length === 0) return;
  try {
    await dispatcher.dispatch(payload.event, channels, payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[login-guard] notification dispatch failed; login flow unaffected',
      err,
    );
  }
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
 *      When the threshold is crossed we record an `ip_blocked` audit
 *      entry (Req 15.1, task 11.2) and fan out the Req 13.1 notification
 *      — the actual block decision is still made by the LoginGuard
 *      middleware on the *next* request, by reading the same counter
 *      (design §6.4). No new DB row is written for the block itself.
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
  notify?: NotificationDeps,
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

  // Req 15.1 — `login_failed` audit entry for EVERY failed attempt
  // (task 11.2). Emitted right after the row is recorded so the audit
  // trail mirrors `login_attempts`. Best-effort + never-throws via
  // {@link writeAudit}. `actorEmail` carries the typed-in address (the
  // would-be actor) — null when blank; `metadata.reason` distinguishes
  // a credential failure from a downstream `account_locked` /
  // `ip_blocked` rejection. No secrets are included (the password is
  // never in scope here).
  await writeAudit(notify, {
    event: 'login_failed',
    actorEmail: actorEmailOrNull(emailLower),
    targetEmail: actorEmailOrNull(emailLower),
    ip,
    userAgent: ctx.userAgent ?? null,
    requestId: notify?.requestId,
    metadata: { reason: ctx.reason },
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

      // Req 13.1 — fan a `user_locked` notification out to the
      // operator's configured channels. Best-effort: the helper
      // swallows any error so a delivery hiccup can't undo the
      // lockout we just committed. `country`/`anomalyScore` are
      // `null` here because `recordLoginFailure` runs on a raw
      // credential failure with no anomaly draft in scope (the geo
      // detector only runs on the success path); `action='locked'`
      // per the Req 13.1 mapping (design §9.1 NotificationAction).
      await dispatchSecurityEvent(notify, policy.notifyChannels, {
        event: 'user_locked',
        timestamp: now.toISOString(),
        email: emailLower,
        ip,
        country: null,
        userAgent: ctx.userAgent ?? null,
        anomalyScore: null,
        action: 'locked',
      });

      // Req 15.1 — `user_locked` audit entry (task 11.2). Best-effort
      // via {@link writeAudit}; the AuditLogger never throws so the
      // lockout we just committed is safe. `targetEmail` is the locked
      // user; `actorEmail` is null because a lockout is system-driven,
      // not performed by an authenticated actor.
      await writeAudit(notify, {
        event: 'user_locked',
        actorEmail: null,
        targetEmail: actorEmailOrNull(emailLower),
        ip,
        userAgent: ctx.userAgent ?? null,
        requestId: notify?.requestId,
        metadata: {
          reason: ctx.reason,
          userFailedCount,
          userMaxFailedAttempts: policy.userMaxFailedAttempts,
          lockoutWindowSeconds: policy.lockoutWindowSeconds,
        },
      });
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
    // Req 15.1 — `ip_blocked` audit entry (task 11.2). This REPLACES
    // the former `console.warn` placeholder: the rate-limit crossing is
    // now recorded as a first-class audit event. Best-effort +
    // never-throws via {@link writeAudit}. `email` is folded into
    // metadata as the *triggering* attempt's address (the block itself
    // is keyed on the IP, not the user), and `actorEmail` is left null
    // because an IP block is system-driven.
    await writeAudit(notify, {
      event: 'ip_blocked',
      actorEmail: null,
      targetEmail: null,
      ip,
      userAgent: ctx.userAgent ?? null,
      requestId: notify?.requestId,
      metadata: {
        triggeringEmail: actorEmailOrNull(emailLower),
        ipFailedCount,
        threshold: ipThreshold,
        lockoutWindowSeconds: policy.lockoutWindowSeconds,
      },
    });

    // Req 13.1 — fan an `ip_blocked` notification out to the
    // operator's configured channels. Best-effort / non-blocking.
    // `email` carries the *triggering* attempt's address so the
    // receiver retains some signal (per the NotificationPayload doc
    // in `notifications/types.ts`), even though the block is keyed on
    // the IP, not the user. `country`/`anomalyScore` are `null` (no
    // anomaly draft on the failure path); `action='blocked'` per the
    // Req 13.1 mapping.
    await dispatchSecurityEvent(notify, policy.notifyChannels, {
      event: 'ip_blocked',
      timestamp: now.toISOString(),
      email: emailLower,
      ip,
      country: null,
      userAgent: ctx.userAgent ?? null,
      anomalyScore: null,
      action: 'blocked',
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
    /**
     * Notification dependencies (task 9.5; Req 13.1). When `ctx
     * .anomalyTriggered === true` — i.e. the `notify_only` path where
     * the login was *allowed* but the score crossed the threshold
     * (Req 12.2) — the hook publishes an `anomaly_triggered` event to
     * `notify.dispatcher` over `notify.notifyChannels`.
     *
     * Unlike `recordLoginFailure` / `recordAnomalyBlock`,
     * `recordLoginSuccess` has no `LockoutPolicy` in scope, so the
     * channel list is passed explicitly via `notify.notifyChannels`
     * (the route resolves it from `policy.notifyChannels`). Omitting
     * `notify` (or supplying no dispatcher / no channels) makes the
     * dispatch a no-op, preserving backward compatibility.
     */
    readonly notify?: NotificationDeps;
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

  // Req 15.1 — `login_success` audit entry (task 11.2). Emitted
  // post-commit, like the `anomaly_triggered` notification below: the
  // login already succeeded and the row is durable, so a best-effort
  // audit write has nothing to roll back and must not be able to fail
  // the committed success. `actorEmail`/`targetEmail` both carry the
  // authenticated user; `metadata` records the anomaly verdict (no
  // secrets — the password never reaches this hook).
  await writeAudit(options.notify, {
    event: 'login_success',
    actorEmail: actorEmailOrNull(emailLower),
    targetEmail: actorEmailOrNull(emailLower),
    ip,
    userAgent: ctx.userAgent ?? null,
    countryCode: draft.countryCode ?? null,
    requestId: options.notify?.requestId,
    metadata: {
      anomalyScore: roundScore(ctx.anomalyScore),
      anomalyTriggered: ctx.anomalyTriggered ?? false,
      baselineWarmup: ctx.baselineWarmup ?? false,
    },
  });

  // Req 13.1 — `anomaly_triggered` notification (design §6.3).
  //
  // Dispatched *after* the transaction commits, not inside it: the
  // login already succeeded and the row is durable, so a dispatch
  // (which only enqueues) has nothing to roll back and must not be
  // able to abort the committed success. Fire only on the
  // `notify_only` path — `ctx.anomalyTriggered === true` is set by
  // the route exactly when the score crossed the threshold,
  // `baselineWarmup === false`, and `anomalyAction === 'notify_only'`
  // (Req 12.2): the login was allowed but the anomaly is the only
  // out-of-band signal something looked off. `action='allowed'`
  // because the request succeeded; the geo detector populated
  // `draft.countryCode` on this path so we forward it, and we round
  // the score to 2 decimals to match the NotificationPayload contract.
  if (ctx.anomalyTriggered === true) {
    await dispatchSecurityEvent(options.notify, options.notify?.notifyChannels ?? [], {
      event: 'anomaly_triggered',
      timestamp: now.toISOString(),
      email: emailLower,
      ip,
      country: draft.countryCode ?? null,
      userAgent: ctx.userAgent ?? null,
      anomalyScore: roundScore(ctx.anomalyScore),
      action: 'allowed',
    });

    // Req 15.1 — `anomaly_triggered` audit entry (task 11.2). Separate
    // from and additional to the notification above: the notification
    // alerts the operator out-of-band, while this entry persists the
    // anomaly into the audit trail. Same `notify_only`-path gate.
    // Best-effort + never-throws via {@link writeAudit}.
    await writeAudit(options.notify, {
      event: 'anomaly_triggered',
      actorEmail: actorEmailOrNull(emailLower),
      targetEmail: actorEmailOrNull(emailLower),
      ip,
      userAgent: ctx.userAgent ?? null,
      countryCode: draft.countryCode ?? null,
      requestId: options.notify?.requestId,
      metadata: {
        anomalyScore: roundScore(ctx.anomalyScore),
        action: 'notify_only',
        baselineWarmup: ctx.baselineWarmup ?? false,
      },
    });
  }
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
  notify?: NotificationDeps,
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

  // Req 15.1 — `anomaly_triggered` audit entry (task 11.2). The
  // anomaly detector firing IS the audit event regardless of which
  // action (`lock` / `require_mfa`) the policy chose — `anomaly_lock`
  // and `mfa_required` are `login_attempts.reason` values, not audit
  // codes (the audit vocabulary's anomaly code is `anomaly_triggered`).
  // Emitted right after the attempt row so the trail mirrors it.
  // Best-effort + never-throws via {@link writeAudit}.
  await writeAudit(notify, {
    event: 'anomaly_triggered',
    actorEmail: actorEmailOrNull(emailLower),
    targetEmail: actorEmailOrNull(emailLower),
    ip,
    userAgent: ctx.userAgent ?? null,
    countryCode: draft.countryCode ?? null,
    requestId: notify?.requestId,
    metadata: {
      anomalyScore: roundScore(ctx.anomalyScore),
      action: ctx.action,
      reason,
      baselineWarmup: ctx.baselineWarmup,
    },
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

    // Req 13.1 — `anomaly_lock` notification. Only the `'lock'`
    // action maps to a Req 13.1 event; `'require_mfa'` deliberately
    // does NOT notify (Req 13.1's set is exactly four events, and
    // `mfa_required` is a placeholder action per Req 12.4 / the
    // `SecurityEvent` union in `notifications/types.ts`). Best-effort
    // / non-blocking; `action='locked'`, and we forward the
    // detector's country + 2-decimal score.
    await dispatchSecurityEvent(notify, policy.notifyChannels, {
      event: 'anomaly_lock',
      timestamp: now.toISOString(),
      email: emailLower,
      ip,
      country: draft.countryCode ?? null,
      userAgent: ctx.userAgent ?? null,
      anomalyScore: roundScore(ctx.anomalyScore),
      action: 'locked',
    });
  }
}

// ── Internal helpers ───────────────────────────────────────────────────

function normaliseIp(input: string | null | undefined): string {
  if (typeof input !== 'string') return 'unknown';
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

/**
 * Round an anomaly score to two decimal places for the
 * {@link NotificationPayload.anomalyScore} wire field (Req 12.1 /
 * design §9.1). Mirrors the `Math.round(score * 100) / 100`
 * convention documented on the payload type so the number a webhook
 * receiver thresholds on matches the value the success-row insert
 * persisted. `null`/`undefined` pass straight through — those events
 * (`user_locked`, `ip_blocked`) aren't anomaly-driven and carry a
 * `null` score by design.
 */
function roundScore(score: number | null | undefined): number | null {
  if (score == null) return null;
  return Math.round(score * 100) / 100;
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
