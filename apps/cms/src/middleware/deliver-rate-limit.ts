import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { consumeRateLimit } from './rate-limit-helper';

/**
 * Delivery-API IP rate limiter
 * (high-load-cache-readiness Req 19.10–19.11; design §14.9).
 *
 * Public, unauthenticated surface — keyed by client IP only (`rl:deliver:${ip}`),
 * deliberately WITHOUT siteId so one IP hammering N sites shares one budget.
 *
 * Config:
 *   - LUMIBASE_DELIVER_RATE_LIMIT   = req/min/IP (default 1200; `0` = off)
 *   - LUMIBASE_RATE_LIMIT_FAIL_CLOSED = `true` → 503 when limiter unavailable
 */

const DEFAULT_MAX = 1200;
const WINDOW_S = 60;

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function withDeliverRateLimit() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const env = c.env ?? ({} as AppEnv['Bindings']);
    const max = envInt(env.LUMIBASE_DELIVER_RATE_LIMIT, DEFAULT_MAX);
    if (max === 0) return next();

    const failClosed = env.LUMIBASE_RATE_LIMIT_FAIL_CLOSED === 'true';
    const runtime = c.get('runtime');
    const rateLimiter = runtime?.rateLimiter;

    const ip = c.get('ip') ?? 'unknown';
    const key = `rl:deliver:${ip}`;

    const verdict = await consumeRateLimit(rateLimiter, key, max, WINDOW_S);

    if (verdict.status === 'unavailable') {
      return failClosed
        ? c.json(
            {
              errors: [
                { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Rate limiter is temporarily unavailable.' },
              ],
            },
            503,
          )
        : next();
    }

    c.header('X-RateLimit-Limit', String(verdict.limit));
    c.header('X-RateLimit-Remaining', String(verdict.remaining));
    c.header('X-RateLimit-Reset', String(verdict.resetAt));

    if (verdict.status === 'block') {
      c.header('Retry-After', String(verdict.retryAfterSeconds));
      c.header('Cache-Control', 'no-store');
      return c.json(
        { errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' }] },
        429,
      );
    }

    return next();
  });
}
