/**
 * TOTP MFA rate limiter — per-user and per-IP budgets on verify/setup paths.
 */

import type { RateLimiterProvider } from '@lumibase/runtime';
import { MemoryRateLimiter } from '@lumibase/runtime';
import { consumeRateLimit } from '../../middleware/rate-limit-helper';

export const TOTP_VERIFY_USER_LIMIT = 10;
export const TOTP_VERIFY_IP_LIMIT = 30;
export const TOTP_VERIFY_WINDOW_SECONDS = 15 * 60;

const fallbackLimiter = new MemoryRateLimiter();

export interface TotpRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

async function checkLimit(
  limiter: RateLimiterProvider,
  key: string,
  limit: number,
): Promise<TotpRateLimitResult> {
  const result = await consumeRateLimit(
    limiter,
    key,
    limit,
    TOTP_VERIFY_WINDOW_SECONDS,
  );
  if (result.status === 'unavailable') {
    return { allowed: true };
  }
  if (result.status === 'block') {
    return { allowed: false, retryAfterSeconds: result.retryAfterSeconds || TOTP_VERIFY_WINDOW_SECONDS };
  }
  return { allowed: true };
}

export async function checkTotpVerifyRateLimit(
  limiter: RateLimiterProvider | undefined,
  userId: string,
  ip: string,
): Promise<TotpRateLimitResult> {
  const rl = limiter ?? fallbackLimiter;
  const ipResult = await checkLimit(rl, `rl:totp:ip:${ip}`, TOTP_VERIFY_IP_LIMIT);
  if (!ipResult.allowed) return ipResult;
  return checkLimit(rl, `rl:totp:user:${userId}`, TOTP_VERIFY_USER_LIMIT);
}
