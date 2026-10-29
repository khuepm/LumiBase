import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { aiIpRateLimitedTotal } from '../routes/metrics';
import { clientHashSecret, hashClientIdentifier } from '../services/client-ip-hash';
import { consumeRateLimit } from './rate-limit-helper';

/**
 * Per-client-IP rate limit for `/api/v1/ai/*` (#564, B147).
 *
 * Runs in the `api` chain after `withTenantExists()` and before `withAuth()`:
 * - after the site check, so a forged `X-Lumi-Site` cannot mint counters for
 *   sites that do not exist (unknown sites already answer 404);
 * - before authentication, so a blocked request costs no JWT verification, no
 *   API-key lookup, no capability resolution, no decision quota reservation,
 *   no provider call and no audit write.
 *
 * Keyed `rl:{siteId}:aiip:{hash}` (`siteId` in colon-segment 2 so Cloudflare
 * keeps the counter in that site's Durable Object; `aiip` cannot collide with
 * a principal id of `withRateLimit`). The IP is hashed with the client
 * identifier hash and never stored.
 *
 * Config:
 *   - LUMIBASE_AI_IP_RATE_LIMIT        = req/min per IP per site (default 300; `0` = off)
 *   - LUMIBASE_RATE_LIMIT_FAIL_CLOSED  = `true` → 503 when the limiter is unavailable
 *     (default: fail open, like `withRateLimit` / `withDeliverRateLimit`)
 *
 * Skipped when the client IP is unknown: on Docker without a proxy that sets
 * `CF-Connecting-IP`, every client resolves to `'unknown'` (B160), and one
 * shared bucket would let one caller lock every Studio user out of AI. The
 * refusal-audit bound does not depend on this limiter.
 *
 * On allow it sets no `X-RateLimit-*` headers; the general per-principal
 * limiter later in the chain owns those.
 */

const DEFAULT_MAX = 300;
const WINDOW_S = 60;
const AI_PREFIX = '/api/v1/ai';

let warnedUnknownIp = false;

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** `/api/v1/ai` and everything below it; not `/api/v1/aix`. */
export function isAiPath(path: string): boolean {
  return path === AI_PREFIX || path.startsWith(`${AI_PREFIX}/`);
}

export function withAiIpRateLimit() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isAiPath(c.req.path)) return next();
    const env = c.env ?? ({} as AppEnv['Bindings']);
    const max = envInt(env.LUMIBASE_AI_IP_RATE_LIMIT, DEFAULT_MAX);
    if (max === 0) return next();

    const ip = c.get('ip');
    if (!ip || ip === 'unknown') {
      if (!warnedUnknownIp) {
        warnedUnknownIp = true;
        console.warn(
          '[ai-ip-rate-limit] client IP is unknown; the /api/v1/ai/* IP limit is skipped. ' +
            'Behind a reverse proxy, set CF-Connecting-IP to the real client IP.',
        );
      }
      return next();
    }

    const siteId = c.get('siteId');
    const key = `rl:${siteId}:aiip:${await hashClientIdentifier(siteId, ip, clientHashSecret(env))}`;
    const verdict = await consumeRateLimit(c.get('runtime')?.rateLimiter, key, max, WINDOW_S);
    if (verdict.status === 'unavailable') {
      return env.LUMIBASE_RATE_LIMIT_FAIL_CLOSED === 'true'
        ? c.json(
            { errors: [{ code: 'RATE_LIMIT_UNAVAILABLE', message: 'Rate limiter is temporarily unavailable.' }] },
            503,
          )
        : next();
    }
    if (verdict.status === 'block') {
      aiIpRateLimitedTotal.inc();
      c.header('X-RateLimit-Limit', String(verdict.limit));
      c.header('X-RateLimit-Remaining', String(verdict.remaining));
      c.header('X-RateLimit-Reset', String(verdict.resetAt));
      c.header('Retry-After', String(verdict.retryAfterSeconds));
      return c.json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' }] }, 429);
    }
    return next();
  });
}
