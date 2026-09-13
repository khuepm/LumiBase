import type { CacheProvider } from '@lumibase/runtime';
import { sites, type Database } from '@lumibase/database';
import { eq } from 'drizzle-orm';

/**
 * Existence check for a tenant id, cached so the per-request cost is a cache
 * hit rather than a `SELECT` against `sites`.
 *
 * `withTenant` only shape-checks `X-Lumi-Site` (see `identifier-guard.ts`,
 * which documents that it deliberately never looks up existence). That leaves
 * an unverified, client-supplied string on the context as `siteId`, which then
 * flows into writes — notably `audit_log.site_id`, whose FK to `sites.id`
 * rejects it and previously crashed the process. This module closes that gap
 * for the pre-auth path.
 *
 * Both outcomes are cached. Caching the negative is what makes this safe to run
 * on unauthenticated requests: a client spraying random site ids cannot turn
 * each bad header into a database round-trip. The negative TTL is short so a
 * freshly-created site becomes reachable quickly.
 */

const PREFIX = 'site-exists:';

/** Positive TTL (seconds). Sites are long-lived; deletion invalidates explicitly. */
const TTL_EXISTS_SECONDS = 60 * 10; // 10m

/**
 * Negative TTL (seconds). Deliberately short: it only needs to be long enough
 * to absorb a burst of bad ids, and a new site must not stay unreachable.
 */
const TTL_MISSING_SECONDS = 30;

export function siteExistsKey(siteId: string): string {
  return `${PREFIX}${siteId}`;
}

/**
 * Resolve whether `siteId` names a real tenant.
 *
 * Fails OPEN when no cache is available and the DB lookup itself throws: this
 * guard exists to stop a bad id reaching an FK, not to be an availability
 * dependency of its own. A DB that cannot answer will fail the request later,
 * on its real query, with a better error than a bogus 404 here.
 */
export async function siteExists(
  db: Database,
  cache: CacheProvider | undefined,
  siteId: string,
): Promise<boolean> {
  const key = siteExistsKey(siteId);

  if (cache) {
    // `getEntry` distinguishes a confirmed absence (tombstone) from an unknown
    // key, which is exactly the distinction this guard needs: a plain `get()`
    // collapses "we know this site does not exist" into the same `null` as
    // "not cached", costing a query per request under a bad-id flood.
    const entry = await cache.getEntry<string>(key);
    if (entry.state === 'hit') return true;
    if (entry.state === 'negative') return false;
  }

  let exists: boolean;
  try {
    const [row] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    exists = Boolean(row);
  } catch {
    return true; // fail open — see doc-block
  }

  if (cache) {
    if (exists) {
      await cache.set(key, siteId, { ttl: TTL_EXISTS_SECONDS });
    } else {
      await cache.setNegative(key, { ttl: TTL_MISSING_SECONDS });
    }
  }
  return exists;
}

/** Drop a cached verdict — call when a site is created or deleted. */
export async function invalidateSiteExists(
  cache: CacheProvider | undefined,
  siteId: string,
): Promise<void> {
  await cache?.delete(siteExistsKey(siteId));
}
