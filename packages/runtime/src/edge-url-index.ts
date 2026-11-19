import type { CacheProvider } from './interfaces/cache';
import { hasMemberSet } from './interfaces/cache';
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
 * Uses the provider's member set ({@link hasMemberSet}) when it has one —
 * every adapter shipped in this package does. Adds to a member set commute, so
 * concurrent cache misses for different URLs under one tag all stay indexed
 * (#864). The previous design appended to one JSON list per tag with
 * `get` + `set`, and two concurrent writers dropped each other's URL.
 *
 * A provider without member sets (a third-party or test double) still gets
 * that read-modify-write fallback, with its known race.
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
      if (hasMemberSet(cache)) {
        await cache.addMember(key, url, { limit, ...(opts?.ttl ? { ttl: opts.ttl } : {}) });
        continue;
      }
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
 * Purge every edge URL recorded under `tag`, then drop the entries the purge
 * reached. A purge that throws, or a URL the provider reports as failed
 * ({@link EdgeCacheProvider.purgeWithOutcome}), leaves those entries indexed
 * for the next attempt.
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
    // The JSON list under `key` is what the read-modify-write design wrote; a
    // member-set provider still reads it so URLs recorded before an upgrade
    // are purged instead of waiting out their TTL.
    const legacy = parseUrls(await cache.get<string>(key));
    // Read without removing: if the purge below throws, the members stay
    // indexed and the next purge retries them.
    const batch = hasMemberSet(cache)
      ? await cache.readMembers(key, { limit: EDGE_URL_INDEX_LIMIT })
      : null;
    const urls = batch ? [...new Set([...legacy, ...batch.members])] : legacy;
    // Pass the tag even with an empty URL list: a provider whose CDN supports
    // tag purge can act on copies this index never recorded.
    // A throw lands in the catch below before anything is acknowledged. The
    // shipped providers never throw, though — they fail soft and return a
    // count — so a provider that can name its failed URLs is asked to.
    const target = { urls, tags: [tag] };
    const outcome = edgeCache.purgeWithOutcome
      ? await edgeCache.purgeWithOutcome(target)
      : { purged: await edgeCache.purge(target), failedUrls: [] as string[] };
    // Acknowledge only what the purge reached; a refused URL stays indexed and
    // the next purge of this tag retries it. That retry is bounded: the index
    // entry expires with the edge copy's own TTL, so a URL that keeps failing
    // is retried until its copy would have expired anyway, and no longer.
    // Only what was read is acknowledged, so a URL recorded during the purge
    // stays indexed too.
    const failed = new Set(outcome.failedUrls);
    await batch?.ack(batch.members.filter((u) => !failed.has(u)));
    // The legacy list is one value; keep all of it while any of it failed.
    if (!legacy.some((u) => failed.has(u))) await cache.delete(key);
    return outcome.purged;
  } catch {
    return 0;
  }
}
