/**
 * Recovery rate limiter — a SHARED 3-requests / IP / hour budget across
 * the `/admin/security/recover` and `/admin/security/forgot-path`
 * endpoints (admin-setup-wizard task 10.6; Req 14.8; design §4.7, §4.8).
 *
 * ── Why a shared counter (Req 14.8) ──────────────────────────────────────
 *
 * Req 14.8 states the Recovery_Service applies a rate limit of
 * "3 request / IP / giờ cho cả `/recover` VÀ `/forgot-path`" to defeat
 * backup-code brute force. The budget is COMBINED, not per-endpoint:
 * a given IP gets 3 recovery-related requests per hour TOTAL across the
 * two endpoints — NOT 3 each. That's why this module exposes a single
 * {@link checkRecoveryRateLimit} backed by one module-level
 * {@link recoveryRateBuckets} map keyed by IP ALONE (never IP+endpoint):
 * both routes (task 10.7) call the same function, so a `/recover` call
 * and a `/forgot-path` call from the same IP draw from the same bucket.
 * If we keyed by IP+endpoint an attacker would get 6 attempts/hour and
 * could split a brute-force burst across the two paths to double their
 * budget — exactly what the shared counter prevents.
 *
 * ── Fixed window (mirrors `setup/routes.ts`) ─────────────────────────────
 *
 * This is a fixed-window limiter, the same shape as the in-memory
 * `checkStateRateLimit` in `apps/cms/src/modules/setup/routes.ts`: the
 * first request from an IP opens a window of {@link RECOVERY_RATE_WINDOW_MS}
 * and every request inside that window counts against the same budget;
 * once the window elapses (`resetAt <= now`) the next request opens a
 * fresh window. A request that gets DENIED does NOT extend the window
 * (we never bump `resetAt` on a deny) — the window is anchored to the
 * first request, so `Retry-After` always shrinks monotonically toward
 * the original deadline. Fixed window is the simplest correct choice and
 * keeps this module consistent with the established setup-routes pattern;
 * a true sliding window would need per-timestamp bookkeeping we don't
 * need for a 3/hour budget.
 *
 * ── In-memory limitation (flagged, same caveat as the token store) ───────
 *
 * The bucket map lives in process memory. It is correct for a SINGLE
 * Node process, but — exactly like the in-memory unlock/recovery token
 * stores in `apps/cms/src/modules/recovery/service.ts` — it does NOT
 * survive a restart and is NOT shared across Cloudflare Workers isolates
 * or multiple Node processes behind a load balancer. A multi-instance
 * production deploy that needs the 3/hour budget enforced globally must
 * back this with a shared store (Redis, or a DB-backed counter over the
 * `login_attempts`-style sliding window). Until then, each isolate /
 * process enforces its own local budget.
 *
 * ── IP extraction is the caller's job ────────────────────────────────────
 *
 * This module is intentionally NOT coupled to Hono: it's a pure
 * `(ip: string) → RateLimitResult` function so it stays unit-testable
 * and reusable. The route layer (task 10.7) extracts the client IP with
 * the existing `extractClientIp` helper
 * (`apps/cms/src/modules/login-guard/ip-extract.ts`) and builds the HTTP
 * envelope itself — see {@link RECOVERY_RATE_LIMIT_CODE} and
 * {@link recoveryRateLimitHeaders} — keeping ownership of the response
 * shape in the route, consistent with how `setup/routes.ts` builds its
 * own 429.
 *
 * **Validates: Requirements 14.8** — design §4.7, §4.8.
 */

/**
 * A fixed-window bucket: how many requests an IP has made in the current
 * window, and the absolute epoch-ms at which the window resets.
 *
 * Same shape as the `RateBucket` in `apps/cms/src/modules/setup/routes.ts`.
 */
interface RateBucket {
  /** Requests counted in the current window. */
  count: number;
  /** Absolute epoch-ms at which the current window expires. */
  resetAt: number;
}

/** Combined requests allowed per IP per window across BOTH endpoints. */
export const RECOVERY_RATE_LIMIT = 3;

/** Window length: one hour, in milliseconds (Req 14.8 — "/ giờ"). */
export const RECOVERY_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The error code the route layer puts in the 429 envelope
 * (`{ errors: [{ code: 'RATE_LIMITED' }] }`). Exposed as a constant so
 * the route owns the HTTP shape while sharing the exact code string —
 * matches the inline `RATE_LIMITED` used by `setup/routes.ts`.
 */
export const RECOVERY_RATE_LIMIT_CODE = 'RATE_LIMITED' as const;

/**
 * Module-level bucket map, keyed by IP ONLY (not IP+endpoint) so the
 * 3/hour budget is SHARED across `/recover` and `/forgot-path`
 * (Req 14.8). Module-level so both routes see the same counters and so
 * tests can reset it between runs via
 * {@link __resetRecoveryRateLimitForTests}.
 */
const recoveryRateBuckets = new Map<string, RateBucket>();

/**
 * The outcome of a rate-limit check.
 */
export interface RateLimitResult {
  /** `true` if the request is within budget and may proceed. */
  allowed: boolean;
  /**
   * Seconds until the current window resets — the value for the
   * `Retry-After` header. Present ONLY when `!allowed`. Always a
   * positive integer (ceil of the remaining window).
   */
  retryAfterSeconds?: number;
  /**
   * Requests left in the current window AFTER accounting for this call.
   * Counts down `LIMIT-1 … 0` across allowed calls; `0` once denied.
   */
  remaining: number;
}

/**
 * Check (and consume, when allowed) one unit of the recovery rate-limit
 * budget for `ip`. Call this once per incoming `/recover` or
 * `/forgot-path` request; because both endpoints share this function and
 * the same {@link recoveryRateBuckets} map, the 3/hour budget is COMBINED
 * across the two (Req 14.8).
 *
 * Fixed-window semantics:
 *   - No bucket, or the window has elapsed (`resetAt <= now`): open a
 *     fresh window (`count = 1`, `resetAt = now + WINDOW_MS`), allow,
 *     `remaining = LIMIT - 1`.
 *   - Window active and `count < LIMIT`: increment, allow,
 *     `remaining = LIMIT - count`.
 *   - Window active and `count >= LIMIT`: DENY. Compute
 *     `retryAfterSeconds = ceil((resetAt - now) / 1000)`, `remaining = 0`.
 *     The denied request does NOT increment the count and does NOT extend
 *     the window (the deadline stays anchored to the first request), so
 *     `Retry-After` only ever shrinks toward the original reset.
 *
 * @param ip  The client IP (extraction is the caller's responsibility —
 *            the route uses `extractClientIp`). Used verbatim as the
 *            bucket key.
 * @param now Injectable wall clock in epoch-ms; defaults to `Date.now()`.
 *            Tests pass explicit numbers so they're deterministic without
 *            fake timers (matches the `now?: number` style elsewhere).
 */
export function checkRecoveryRateLimit(
  ip: string,
  now: number = Date.now(),
): RateLimitResult {
  const bucket = recoveryRateBuckets.get(ip);

  // Fresh window: no prior bucket, or the previous window has elapsed.
  if (!bucket || bucket.resetAt <= now) {
    recoveryRateBuckets.set(ip, {
      count: 1,
      resetAt: now + RECOVERY_RATE_WINDOW_MS,
    });
    return { allowed: true, remaining: RECOVERY_RATE_LIMIT - 1 };
  }

  // Within an active window and still under budget: count this request.
  if (bucket.count < RECOVERY_RATE_LIMIT) {
    bucket.count += 1;
    return { allowed: true, remaining: RECOVERY_RATE_LIMIT - bucket.count };
  }

  // Budget exhausted: deny WITHOUT touching count or resetAt (fixed
  // window — the deadline stays anchored to the first request).
  const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
  return { allowed: false, retryAfterSeconds, remaining: 0 };
}

/**
 * Build the header bag for a 429 recovery response. Tiny convenience so
 * the route can write `c.json(envelope, 429, recoveryRateLimitHeaders(s))`
 * without re-deriving the header name. The route still owns the JSON body
 * (e.g. `{ errors: [{ code: RECOVERY_RATE_LIMIT_CODE }] }`).
 */
export function recoveryRateLimitHeaders(
  retryAfterSeconds: number,
): { readonly 'Retry-After': string } {
  return { 'Retry-After': String(retryAfterSeconds) };
}

/**
 * Clear all rate-limit state. Test-only — mirrors
 * `__resetSetupRateLimitForTests` in `setup/routes.ts` so suites can
 * isolate the shared module-level map between cases.
 */
export function __resetRecoveryRateLimitForTests(): void {
  recoveryRateBuckets.clear();
}
