import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/**
 * General API rate limiting (CWE-400 / CWE-770).
 *
 * A coarse fixed-window throttle applied to the authenticated API surface, in
 * addition to the auth-specific limiters (login/recovery) and the global
 * event-loop pressure limiter. It is defence-in-depth against a single
 * principal or IP hammering REST/GraphQL — not a precise quota.
 *
 * Storage is the runtime cache (KV on Workers, Redis/in-memory on Node). The
 * cache exposes only get/set (no atomic increment), so the read-modify-write
 * window can undercount under high concurrency; that is acceptable for a
 * safety-net throttle. Precise per-endpoint quotas would need an atomic
 * counter (a Durable Object or Redis INCR) and are out of scope here.
 *
 * Keying: authenticated principal (userId or API-key id) when available, else
 * client IP. Scoped per site so one tenant cannot exhaust another's budget.
 *
 * Config (env, all optional):
 *   - LUMIBASE_RATE_LIMIT_DISABLED = 'true'  → disable entirely
 *   - LUMIBASE_RATE_LIMIT_MAX      = integer → requests per window (default 300)
 *   - LUMIBASE_RATE_LIMIT_WINDOW_S = integer → window seconds (default 60)
 */

const DEFAULT_MAX = 300;
const DEFAULT_WINDOW_S = 60;

interface WindowState {
  count: number;
  resetAt: number; // epoch ms
}

function envInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolvePrincipalKey(c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0]): string {
  const auth = c.get('auth');
  if (auth?.userId) return `u:${auth.userId}`;
  if (auth?.apiKeyId) return `k:${auth.apiKeyId}`;
  const ip = c.get('ip');
  return `ip:${ip ?? 'unknown'}`;
}

export function withRateLimit() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const env = c.env ?? ({} as AppEnv['Bindings']);
    if (env.LUMIBASE_RATE_LIMIT_DISABLED === 'true') {
      return next();
    }

    const max = envInt(env.LUMIBASE_RATE_LIMIT_MAX, DEFAULT_MAX);
    const windowS = envInt(env.LUMIBASE_RATE_LIMIT_WINDOW_S, DEFAULT_WINDOW_S);

    const runtime = c.get('runtime');
    const cache = runtime?.cache;
    // No cache available (some test harnesses): fail open — the throttle is
    // defence-in-depth, never the sole control.
    if (!cache) return next();

    const siteId = c.get('siteId') ?? 'global';
    const principal = resolvePrincipalKey(c);
    const key = `ratelimit:${siteId}:${principal}`;

    const nowHeader = c.req.header('date');
    const now = nowHeader ? Date.parse(nowHeader) || epochFromContext(c) : epochFromContext(c);

    let state: WindowState | null = null;
    try {
      state = await cache.get<WindowState>(key);
    } catch {
      return next(); // cache read failure → fail open
    }

    let next429 = false;
    let current: WindowState;
    if (!state || typeof state.resetAt !== 'number' || state.resetAt <= now) {
      current = { count: 1, resetAt: now + windowS * 1000 };
    } else if (state.count < max) {
      current = { count: state.count + 1, resetAt: state.resetAt };
    } else {
      current = state;
      next429 = true;
    }

    // Persist the window with a TTL matching its remaining lifetime.
    const ttl = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    try {
      await cache.set(key, JSON.stringify(current), { ttl });
    } catch {
      // Best-effort: if we cannot persist, do not block the request.
      return next();
    }

    const remaining = Math.max(0, max - current.count);
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));

    if (next429) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' }] },
        429,
      );
    }

    return next();
  });
}

/**
 * Epoch-ms source. `Date.now()` is fine in the running app; kept behind a helper
 * so the window logic is easy to reason about and to swap in tests if needed.
 */
function epochFromContext(_c: unknown): number {
  return Date.now();
}
