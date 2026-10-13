/**
 * Hard per-target rate limit for deploy triggers (spec: deployment-integrations
 * task 6.2, Req 9.5; design §6.2 / §9).
 *
 * A deploy trigger is an expensive, provider-billed operation: every accepted
 * trigger calls the Vercel/Netlify API and starts a build. `status='active'` +
 * `requireSiteAdmin` gate *who* may trigger, not *how often* — so a script (or
 * a stuck flow) holding admin credentials could still hammer the Provider API
 * until the tenant's account is throttled or its build minutes are burnt.
 *
 * The brake is a two-tier fixed window on the runtime {@link RateLimiterProvider}
 * (Redis INCR on Docker, cache.increment / per-isolate memory on Cloudflare) —
 * the same mechanism as the general API limiter and the TOTP verify limiter.
 * Never touches a Cloudflare binding directly (Strict Rule #3).
 *
 * Scoping (multi-tenancy, Req 9.1): keys carry BOTH `siteId` and `targetId`, so
 * two targets never share a budget and site A can never exhaust site B's.
 *
 * Failure posture: when no limiter is reachable the check is treated as
 * `unavailable` and **allows** the trigger. A limiter outage must not take
 * deployments down; the pre-existing gates (admin + active target) still apply.
 */

import type { RateLimiterProvider } from '@lumibase/runtime';
import { MemoryRateLimiter } from '@lumibase/runtime';
import { consumeRateLimit } from '../../middleware/rate-limit-helper';

export interface DeployTriggerRateLimit {
  /** Burst budget: max triggers per {@link burstWindowSeconds}. */
  readonly burstMax: number;
  readonly burstWindowSeconds: number;
  /** Sustained budget: max triggers per {@link sustainedWindowSeconds}. */
  readonly sustainedMax: number;
  readonly sustainedWindowSeconds: number;
}

/**
 * Defaults sized for a human (or a well-behaved flow) rather than a script:
 * 5 builds/minute absorbs an impatient "deploy again", and 30 builds/hour is
 * already far above any sane editorial cadence while capping the worst case at
 * roughly one build every two minutes sustained.
 */
export const DEFAULT_DEPLOY_TRIGGER_RATE_LIMIT: DeployTriggerRateLimit = {
  burstMax: 5,
  burstWindowSeconds: 60,
  sustainedMax: 30,
  sustainedWindowSeconds: 3600,
};

export interface DeployTriggerRateVerdict {
  allowed: boolean;
  /** Seconds to back off; only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

/**
 * Per-isolate fallback used when the caller has no runtime limiter (flow
 * handlers, AI harness, queue workers construct the service without one).
 * Weaker than the distributed limiter but strictly better than no brake —
 * same pattern as `modules/mfa/rate-limit.ts`.
 */
const fallbackLimiter = new MemoryRateLimiter();

/** Budget key for one tier. Includes siteId + targetId — never a bare key. */
export function deployTriggerKey(tier: 'burst' | 'hour', siteId: string, targetId: string): string {
  return `rl:deploy:${tier}:${siteId}:${targetId}`;
}

/**
 * Consume one unit of a target's trigger budget. Call this immediately before
 * the outbound Provider call so that triggers which never reach the Provider
 * (e.g. coalesced auto-deploys) don't spend budget.
 */
export async function checkDeployTriggerRate(
  limiter: RateLimiterProvider | undefined,
  siteId: string,
  targetId: string,
  limit: DeployTriggerRateLimit = DEFAULT_DEPLOY_TRIGGER_RATE_LIMIT,
): Promise<DeployTriggerRateVerdict> {
  const rl = limiter ?? fallbackLimiter;

  const burst = await consumeRateLimit(
    rl,
    deployTriggerKey('burst', siteId, targetId),
    limit.burstMax,
    limit.burstWindowSeconds,
  );
  if (burst.status === 'block') {
    return {
      allowed: false,
      retryAfterSeconds: burst.retryAfterSeconds || limit.burstWindowSeconds,
    };
  }

  const sustained = await consumeRateLimit(
    rl,
    deployTriggerKey('hour', siteId, targetId),
    limit.sustainedMax,
    limit.sustainedWindowSeconds,
  );
  if (sustained.status === 'block') {
    return {
      allowed: false,
      retryAfterSeconds: sustained.retryAfterSeconds || limit.sustainedWindowSeconds,
    };
  }

  // 'allow' or 'unavailable' → let it through (fail open, see file docstring).
  return { allowed: true, retryAfterSeconds: 0 };
}
