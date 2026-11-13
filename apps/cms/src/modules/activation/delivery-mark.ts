/**
 * Records a site's `delivery_request` milestone: the first successful content
 * read made by a client rather than by a person working in Studio.
 *
 * Two surfaces count:
 *   • any `GET /api/v1/deliver/*` answered 2xx/304 (the public Delivery API);
 *   • any `GET /api/v1/items/*` answered 2xx/304 to an API-key principal (how
 *     the SDK and the starter read content).
 *
 * This sits on the read path, so it is built to cost nothing after the first
 * hit: an in-process set answers for the life of the isolate/process, the
 * shared cache answers across isolates, and only a site never seen by either
 * reaches the database — one idempotent insert, ever. Every failure is
 * swallowed: a milestone is never worth a failed read.
 *
 * Only the timestamp is stored. No path, key, IP or user agent.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../env';
import { scopedDbFor } from '../../middleware/db';
import { ActivationService } from './service';

type AppContext = Context<AppEnv>;

const SEEN_LIMIT = 10_000;
const seen = new Set<string>();

/** Cache marker lifetime. Long: the milestone itself never expires. */
const MARK_TTL_SECONDS = 30 * 24 * 60 * 60;

export function deliveryMarkCacheKey(siteId: string): string {
  return `activation:delivery:${siteId}`;
}

/** Test hook: forget the in-process set. */
export function resetDeliveryMarkMemory(): void {
  seen.clear();
}

async function mark(c: AppContext, siteId: string): Promise<void> {
  if (seen.has(siteId)) return;
  const cache = c.get('runtime')?.cache;
  const key = deliveryMarkCacheKey(siteId);
  if (cache && (await cache.get(key)) !== null) {
    remember(siteId);
    return;
  }
  await new ActivationService({ db: scopedDbFor(c, siteId), siteId }).record('delivery_request');
  remember(siteId);
  if (cache) await cache.set(key, '1', { ttl: MARK_TTL_SECONDS });
}

function remember(siteId: string): void {
  if (seen.size >= SEEN_LIMIT) seen.clear();
  seen.add(siteId);
}

function served(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

/**
 * @param resolveSiteId where the site comes from on this surface. Returning
 *   `null` means "this request does not count".
 */
export function withDeliveryMilestone(
  resolveSiteId: (c: AppContext) => string | null | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.req.method !== 'GET' || !served(c.res.status)) return;
    try {
      const siteId = resolveSiteId(c);
      if (siteId) await mark(c, siteId);
    } catch {
      // Best-effort by design — see the module doc.
    }
  };
}

/** `/api/v1/deliver/<kind>/:site_id/...` — the site is the second path segment. */
export function deliverPathSiteId(c: AppContext): string | null {
  const match = /\/deliver\/[^/]+\/([^/]+)/.exec(new URL(c.req.url).pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** `/api/v1/items/*` — only API-key principals count as delivery. */
export function apiKeySiteId(c: AppContext): string | null {
  const auth = c.get('auth');
  if (!auth?.apiKeyId) return null;
  return c.get('siteId') ?? null;
}
