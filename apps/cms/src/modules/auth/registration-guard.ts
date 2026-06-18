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

import type { CacheProvider } from '@lumibase/runtime';

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
 * Check (and increment) the per-IP registration counter. Returns
 * `allowed: false` once the IP has exceeded `maxPerWindow` within the
 * window. A missing/unknown IP is allowed (we cannot key it) — the
 * upstream tenant/IP middleware resolves the canonical IP.
 */
export async function checkRegistrationRate(
  cache: CacheProvider,
  siteId: string,
  ip: string | undefined,
  limit: RegistrationRateLimit = DEFAULT_REGISTRATION_RATE_LIMIT,
): Promise<RateLimitVerdict> {
  const trimmedIp = (ip ?? '').trim();
  if (trimmedIp.length === 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const key = `reg-rate:${siteId}:${trimmedIp}`;
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
    // Fail open — a cache outage must not break registration.
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
