/**
 * Best-effort per-IP rate limit for the public self-service registration
 * endpoint.
 *
 * Self-service `/auth/register` is unauthenticated and writes to the
 * global `users` table, so it needs an abuse brake independent of the
 * LoginGuard (which keys on `login_attempts`). We use the runtime cache
 * (CF KV / in-memory Docker adapter) as a fixed-window counter keyed on
 * `siteId + IP` — edge-native and storage-free (Strict Rule #3: never
 * touch CF bindings directly; go through `c.get('runtime').cache`).
 *
 * The counter is intentionally *best-effort*: the cache `get`/`set`
 * sequence is not atomic, so a burst of concurrent requests from one IP
 * can slip a few past the limit. That is an acceptable trade for a
 * signup brake — the goal is to stop scripted mass-registration, not to
 * enforce an exact quota. For hard guarantees an operator can front the
 * endpoint with an edge WAF rule. Cache failures fail *open* (allow): a
 * cache outage must not take registration down, mirroring the
 * "degrade cleanly" posture of the security dispatcher.
 */

import type { CacheProvider, RateLimiterProvider } from '@lumibase/runtime';
import { consumeRateLimit } from '../../middleware/rate-limit-helper';

export interface RegistrationRateLimit {
  /** Max registration attempts per IP within the window. */
  readonly maxPerWindow: number;
  /** Fixed-window length in seconds. */
  readonly windowSeconds: number;
}

export const DEFAULT_REGISTRATION_RATE_LIMIT: RegistrationRateLimit = {
  maxPerWindow: 5,
  windowSeconds: 3600,
};

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds the client should back off when `allowed` is false. */
  retryAfterSeconds: number;
}

/**
 * Generic best-effort per-IP fixed-window rate limit over the runtime
 * cache. `scope` namespaces the counter so different unauthenticated
 * flows (registration, forgot-password, …) don't share a bucket. A
 * missing/unknown IP is allowed (we cannot key it). Fails open on cache
 * error.
 */
export async function checkIpRateLimit(
  cache: CacheProvider,
  scope: string,
  siteId: string,
  ip: string | undefined,
  limit: RegistrationRateLimit,
): Promise<RateLimitVerdict> {
  const trimmedIp = (ip ?? '').trim();
  if (trimmedIp.length === 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const key = `${scope}:${siteId}:${trimmedIp}`;
  try {
    const raw = await cache.get(key);
    const current = raw ? Number.parseInt(raw, 10) : 0;
    const count = Number.isFinite(current) && current > 0 ? current : 0;

    if (count >= limit.maxPerWindow) {
      return { allowed: false, retryAfterSeconds: limit.windowSeconds };
    }

    // Fixed-window: every write resets the TTL. Good enough for an abuse
    // brake; a sliding window would need an atomic backend we don't have.
    await cache.set(key, String(count + 1), { ttl: limit.windowSeconds });
    return { allowed: true, retryAfterSeconds: 0 };
  } catch {
    // Fail open — a cache outage must not break the flow it guards.
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Per-IP registration rate limit. Thin wrapper over
 * {@link checkIpRateLimit} kept for call-site clarity and back-compat.
 */
export function checkRegistrationRate(
  cache: CacheProvider,
  siteId: string,
  ip: string | undefined,
  limit: RegistrationRateLimit = DEFAULT_REGISTRATION_RATE_LIMIT,
): Promise<RateLimitVerdict> {
  return checkIpRateLimit(cache, 'reg-rate', siteId, ip, limit);
}

/**
 * Budget for the public token-consuming endpoints (`/auth/verify-email`,
 * `/auth/reset-password`) — #732. The tokens are signed JWTs, so guessing one
 * is not the threat; the brake caps the JWT-verify + PBKDF2 work an anonymous
 * caller can force, and how fast one leaked link can be replayed.
 */
export const TOKEN_CONSUME_RATE_LIMIT: RegistrationRateLimit = {
  maxPerWindow: 20,
  windowSeconds: 900,
};

/** The two runtime handles {@link checkAuthFlowRate} can count with. */
export interface AuthFlowRateRuntime {
  readonly cache: CacheProvider;
  readonly rateLimiter?: RateLimiterProvider;
}

/**
 * Per-IP brake for the public auth flows (register, resend-verification,
 * forgot-password, verify-email, reset-password) — #732.
 *
 * Prefers the runtime's atomic {@link RateLimiterProvider} (Redis `INCR`, the
 * CF counter, or the per-isolate memory limiter): its consume is one atomic
 * step, so a burst of N parallel requests from one IP is admitted at most
 * `maxPerWindow` times. {@link checkIpRateLimit} is a `get` then a `set` over
 * the cache — every request of a parallel burst can read the same count and
 * slip through, which is exactly the flood a brake exists to stop (Strapi
 * #26494). The cache path stays as the fallback for a runtime without a
 * limiter (some tests, older adapters).
 *
 * Same posture as before on everything else: a missing IP cannot be keyed and
 * is allowed, and a limiter outage fails open — the brake must not take the
 * flow it guards down with it.
 */
export async function checkAuthFlowRate(
  runtime: AuthFlowRateRuntime,
  scope: string,
  siteId: string,
  ip: string | undefined,
  limit: RegistrationRateLimit,
): Promise<RateLimitVerdict> {
  if (!runtime.rateLimiter) {
    return checkIpRateLimit(runtime.cache, scope, siteId, ip, limit);
  }
  const trimmedIp = (ip ?? '').trim();
  if (trimmedIp.length === 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const verdict = await consumeRateLimit(
    runtime.rateLimiter,
    `rl:${scope}:${siteId}:${trimmedIp}`,
    limit.maxPerWindow,
    limit.windowSeconds,
  );
  return verdict.status === 'block'
    ? { allowed: false, retryAfterSeconds: verdict.retryAfterSeconds }
    : { allowed: true, retryAfterSeconds: 0 };
}
