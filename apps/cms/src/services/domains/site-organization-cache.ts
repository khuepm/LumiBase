import type { CacheProvider } from '@lumibase/runtime';
import { sites, type Database } from '@lumibase/database';
import { eq } from 'drizzle-orm';

/**
 * Site → owning organization, cached so the request path can name the
 * organization behind a `siteId` without a `SELECT` against `sites` per request.
 *
 * Same approach as `site-exists-cache.ts`, next to it on purpose: one key per
 * site, a long positive TTL with explicit invalidation, and a short negative
 * TTL so a burst of unknown ids costs one query rather than one per request.
 *
 * `sites.organization_id` is `NOT NULL`, so a cached value is always the
 * organization id itself and "no row" is the only negative outcome.
 *
 * Isolation: the key carries the site id and nothing else, and the value is
 * only ever written from the row whose primary key is that same id. Asking
 * about one site can therefore neither read nor overwrite another site's entry.
 *
 * Staleness: `invalidateSiteOrganization` runs after the transaction that moves
 * or deletes a site commits. A reader that selected the old row just before the
 * commit can still write it back afterwards; that entry then lives for at most
 * `TTL_SECONDS`. Callers that must not act on a stale owner — authorization —
 * keep reading the database (see `organizationRoleForSite`).
 */

const PREFIX = 'site-org:';

/** Positive TTL (seconds). Ownership changes are rare and invalidate explicitly. */
const TTL_SECONDS = 60 * 10; // 10m

/** Negative TTL (seconds). Short, so a new site is attributed quickly. */
const TTL_MISSING_SECONDS = 30;

export function siteOrganizationKey(siteId: string): string {
  return `${PREFIX}${siteId}`;
}

/**
 * The organization that owns `siteId`, or `null` when the site does not exist
 * or the lookup could not be completed.
 *
 * Never throws. A database error yields `null` and is not cached: callers use
 * the result for attribution, and "unknown" is a safe answer where a failed
 * request is not.
 */
export async function siteOrganizationId(
  db: Database,
  cache: CacheProvider | undefined,
  siteId: string,
): Promise<string | null> {
  const key = siteOrganizationKey(siteId);

  if (cache) {
    try {
      const entry = await cache.getEntry<string>(key);
      if (entry.state === 'hit' && typeof entry.value === 'string' && entry.value) return entry.value;
      if (entry.state === 'negative') return null;
    } catch {
      // An unreadable cache is a miss, not a failure.
    }
  }

  let organizationId: string | null;
  try {
    const [row] = await db
      .select({ organizationId: sites.organizationId })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    organizationId = typeof row?.organizationId === 'string' ? row.organizationId : null;
  } catch {
    return null;
  }

  if (cache) {
    try {
      // Adapters read entries back as JSON, so the id is stored JSON-encoded.
      if (organizationId) await cache.set(key, JSON.stringify(organizationId), { ttl: TTL_SECONDS });
      else await cache.setNegative(key, { ttl: TTL_MISSING_SECONDS });
    } catch {
      // Best-effort: the answer is still correct without the cache write.
    }
  }
  return organizationId;
}

/**
 * Drop the cached owner of a site. Call after a site is created, transferred
 * to another organization, or deleted — once the write has committed.
 */
export async function invalidateSiteOrganization(
  cache: CacheProvider | undefined,
  siteId: string,
): Promise<void> {
  await cache?.delete(siteOrganizationKey(siteId));
}
