/**
 * Recovery rate limiter — a SHARED 3-requests / IP / hour budget across
 * the `/admin/security/recover` and `/admin/security/forgot-path`
 * endpoints (admin-setup-wizard task 10.6; Req 14.8; design §4.7, §4.8).
 *
 * Backed by {@link RateLimiterProvider} on the runtime context (Redis on
 * Docker, cache.increment / per-isolate memory on Cloudflare). Key:
 * `rl:recovery:${ip}` — shared across both endpoints so an attacker cannot
 * double the budget by splitting across paths.
 */

import type { RateLimiterProvider } from '@lumibase/runtime';
import { MemoryRateLimiter } from '@lumibase/runtime';
import { consumeRateLimit } from '../../middleware/rate-limit-helper';

/** Combined requests allowed per IP per window across BOTH endpoints. */
export const RECOVERY_RATE_LIMIT = 3;

/** Window length: one hour, in seconds (Req 14.8 — "/ giờ"). */
export const RECOVERY_RATE_WINDOW_SECONDS = 60 * 60;

/**
 * The error code the route layer puts in the 429 envelope
 * (`{ errors: [{ code: 'RATE_LIMITED' }] }`).
 */
export const RECOVERY_RATE_LIMIT_CODE = 'RATE_LIMITED' as const;

/** In-process fallback for unit tests and missing runtime.rateLimiter. */
const fallbackLimiter = new MemoryRateLimiter();

/**
 * The outcome of a rate-limit check.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  remaining: number;
}

/**
 * Check (and consume) one unit of the shared recovery budget for `ip`.
 */
export async function checkRecoveryRateLimit(
  rateLimiter: RateLimiterProvider | undefined,
  ip: string,
): Promise<RateLimitResult> {
  const limiter = rateLimiter ?? fallbackLimiter;
  const key = `rl:recovery:${ip}`;
  const verdict = await consumeRateLimit(
    limiter,
    key,
    RECOVERY_RATE_LIMIT,
    RECOVERY_RATE_WINDOW_SECONDS,
  );

  if (verdict.status === 'unavailable') {
    return { allowed: true, remaining: RECOVERY_RATE_LIMIT - 1 };
  }

  return {
    allowed: verdict.status === 'allow',
    retryAfterSeconds: verdict.retryAfterSeconds || undefined,
    remaining: verdict.remaining,
  };
}

export function recoveryRateLimitHeaders(
  retryAfterSeconds: number,
): { readonly 'Retry-After': string } {
  return { 'Retry-After': String(retryAfterSeconds) };
}

/** Clear fallback limiter state. Test-only. */
export function __resetRecoveryRateLimitForTests(): void {
  fallbackLimiter.clear();
}
