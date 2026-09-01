import type { CacheProvider } from './interfaces/cache';
import type { EdgeCacheProvider } from './interfaces/edge-cache';

/**
 * Tag → edge-URL index (#392).
 *
 * Purging the edge by *tag* is an Enterprise-only Cloudflare feature, while
 * purging by *URL* works on every plan. So LumiBase keeps the tag→URL mapping
 * itself: every response stored at the edge records its URL under the same
 * tags the application cache already uses, and a tag purge reads that list
 * back and hands the URLs to {@link EdgeCacheProvider.purge}.
 *
 * The index lives in the CacheProvider (Redis / Workers KV) next to the tag
 * index that provider already maintains for its own keys — deliberately not in
 * Postgres, because a purge must not add a DB round-trip to the write path.
 *
 * Loss of this index degrades to the old behaviour: the edge keeps serving
 * until `s-maxage`. That is why every operation here is best-effort and no
 * caller may treat its result as a correctness guarantee.
 */

/** Cap per tag. Bounds both the KV value size and the purge fan-out. */
export const EDGE_URL_INDEX_LIMIT = 200;

/** Index key for a tag. The tag already carries `siteId`, so this key does too. */
export function edgeUrlIndexKey(tag: string): string {
  return `edgeurls:${tag}`;
}

function parseUrls(raw: unknown): string[] {
  if (typeof raw !== 'string') return Array.isArray(raw) ? (raw as string[]) : [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Record that `url` is now stored at the edge under each of `tags`.
 *
 * Read-modify-write, so two concurrent writers can lose one URL from the
 * index. The cost of that is one stale edge entry expiring on `s-maxage`
 * instead of being purged — acceptable, and cheaper than a lock on the read
 * path that this runs on.
 *
 * At the cap the oldest entry is dropped rather than rejecting the new one:
 * a URL just written is more likely to matter than one recorded 200 writes
 * ago, and an unbounded list would eventually exceed the KV value limit and
 * lose *everything* under that tag.
 */
export async function recordEdgeUrl(
  cache: CacheProvider | null | undefined,
  tags: readonly string[],
  url: string,
  opts?: { ttl?: number; limit?: number },
): Promise<void> {
  if (!cache || tags.length === 0 || !url) return;
  const limit = opts?.limit ?? EDGE_URL_INDEX_LIMIT;

  for (const tag of tags) {
    try {
      const key = edgeUrlIndexKey(tag);
      const existing = parseUrls(await cache.get<string>(key));
      if (existing.includes(url)) continue;
      const next = [...existing, url].slice(-limit);
      await cache.set(key, JSON.stringify(next), opts?.ttl ? { ttl: opts.ttl } : undefined);
    } catch {
      // Index maintenance never fails the response it is describing.
    }
  }
}

/**
 * Purge every edge URL recorded under `tag`, then drop the index entry.
 *
 * Returns how many URLs the edge provider reported purging (0 when there is
 * no edge, no index, or the purge failed) — an observability signal only.
 */
export async function purgeEdgeByTag(
  cache: CacheProvider | null | undefined,
  edgeCache: EdgeCacheProvider | null | undefined,
  tag: string,
): Promise<number> {
  if (!cache || !edgeCache) return 0;
  try {
    const key = edgeUrlIndexKey(tag);
    const urls = parseUrls(await cache.get<string>(key));
    // Pass the tag even with an empty URL list: a provider whose CDN supports
    // tag purge can act on copies this index never recorded.
    const purged = await edgeCache.purge({ urls, tags: [tag] });
    // Drop the index even when the purge reported 0: the entries it points at
    // are expiring on their own clock anyway, and keeping a list that failed
    // once would make every later purge retry the same dead URLs forever.
    await cache.delete(key);
    return purged;
  } catch {
    return 0;
  }
}
