import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { consumeRateLimit } from './rate-limit-helper';

/**
 * General API rate limiting (CWE-400 / CWE-770).
 *
 * Distributed fixed-window throttle via {@link RateLimiterProvider} on the
 * runtime context (Redis INCR on Docker, cache.increment / per-isolate memory
 * on Cloudflare). Keys are tenant-scoped: `rl:${siteId}:${principal}`.
 *
 * Config:
 *   - LUMIBASE_API_RATE_LIMIT       = req/min/principal (default 600; `0` = off)
 *   - LUMIBASE_RATE_LIMIT_FAIL_CLOSED = `true` → 503 when limiter unavailable
 *
 * Skips `/health` and `/metrics` only. Delivery has a dedicated IP limiter
 * (`withDeliverRateLimit`) on its own mount.
 */

const DEFAULT_MAX_PER_MIN = 600;
const WINDOW_S = 60;

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolvePrincipalKey(c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0]): string {
  const auth = c.get('auth');
  if (auth?.userId) return auth.userId;
  if (auth?.apiKeyId) return auth.apiKeyId;
  return 'anon';
}

function shouldSkipRateLimit(path: string): boolean {
  return path === '/health' || path.startsWith('/health/') || path === '/metrics';
}

export function withRateLimit() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (shouldSkipRateLimit(c.req.path)) {
      return next();
    }

    const env = c.env ?? ({} as AppEnv['Bindings']);
    const max = envInt(env.LUMIBASE_API_RATE_LIMIT, DEFAULT_MAX_PER_MIN);
    if (max === 0) {
      return next();
    }

    const failClosed = env.LUMIBASE_RATE_LIMIT_FAIL_CLOSED === 'true';
    const runtime = c.get('runtime');
    const rateLimiter = runtime?.rateLimiter;

    const siteId = c.get('siteId') ?? 'global';
    const principal = resolvePrincipalKey(c);
    const key = `rl:${siteId}:${principal}`;

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
      return c.json(
        { errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' }] },
        429,
      );
    }

    return next();
  });
}
