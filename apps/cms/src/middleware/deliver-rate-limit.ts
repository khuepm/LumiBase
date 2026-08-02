import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/**
 * Delivery-API IP rate limiter
 * (high-load-cache-readiness Req 19.10–19.11; design §14.9).
 *
 * Public, unauthenticated surface — keyed by client IP only (`rl:deliver:${ip}`),
 * deliberately WITHOUT siteId so one IP hammering N sites shares one budget.
 * Fail-open by default (same policy as `withRateLimit`); honour
 * `LUMIBASE_RATE_LIMIT_FAIL_CLOSED`.
 *
 * IP is read from `c.get('ip')` (populated by `withAuditContext` via
 * `extractClientIp`) — never re-parsed from headers here.
 *
 * Config:
 *   - LUMIBASE_DELIVER_RATE_LIMIT   = req/min/IP (default 1200; `0` = off)
 *   - LUMIBASE_RATE_LIMIT_FAIL_CLOSED = 'true' → 503 when cache unavailable
 */

const DEFAULT_MAX = 1200;
const WINDOW_S = 60;

interface WindowState {
  count: number;
  resetAt: number;
}

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
    const unavailable = () =>
      c.json(
        {
          errors: [
            { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Rate limiter is temporarily unavailable.' },
          ],
        },
        503,
      );

    const runtime = c.get('runtime');
    const cache = runtime?.cache;
    if (!cache) return failClosed ? unavailable() : next();

    const ip = c.get('ip') ?? 'unknown';
    const key = `rl:deliver:${ip}`;
    const now = Date.now();

    let state: WindowState | null = null;
    try {
      state = await cache.get<WindowState>(key);
    } catch {
      return failClosed ? unavailable() : next();
    }

    let next429 = false;
    let current: WindowState;
    if (!state || typeof state.resetAt !== 'number' || state.resetAt <= now) {
      current = { count: 1, resetAt: now + WINDOW_S * 1000 };
    } else if (state.count < max) {
      current = { count: state.count + 1, resetAt: state.resetAt };
    } else {
      current = state;
      next429 = true;
    }

    const ttl = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    try {
      await cache.set(key, JSON.stringify(current), { ttl });
    } catch {
      return failClosed ? unavailable() : next();
    }

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - current.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));

    if (next429) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      c.header('Cache-Control', 'no-store');
      return c.json(
        { errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' }] },
        429,
      );
    }

    return next();
  });
}
