import type { EdgeCacheProvider } from '../../interfaces/edge-cache';

/**
 * Minimal Cache Storage API surface (Cloudflare Workers `caches.default`).
 * Declared locally to avoid importing @cloudflare/workers-types in business code.
 */
interface EdgeCacheStorage {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

declare const caches: { default: EdgeCacheStorage } | undefined;

/** Credentials for the global zone purge API. Absent → local-only purge. */
export interface CloudflareZonePurgeConfig {
  zoneId: string;
  apiToken: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Cloudflare's cap on URLs per single-file purge call. */
const PURGE_BATCH_SIZE = 30;

/** Thin adapter around the Workers Cache API (`caches.default`). */
export class CloudflareEdgeCacheProvider implements EdgeCacheProvider {
  constructor(private zonePurge?: CloudflareZonePurgeConfig) {}

  private get cache(): EdgeCacheStorage | undefined {
    return typeof caches !== 'undefined' ? caches.default : undefined;
  }

  async match(request: Request): Promise<Response | null> {
    const hit = await this.cache?.match(request);
    return hit ?? null;
  }

  async put(request: Request, response: Response): Promise<void> {
    await this.cache?.put(request, response);
  }

  /** One zone purge_cache call. Resolves false on any non-2xx or throw. */
  private async zoneCall(body: Record<string, string[]>): Promise<boolean> {
    const zone = this.zonePurge;
    if (!zone) return false;
    const doFetch = zone.fetchImpl ?? fetch;
    try {
      const res = await doFetch(
        `https://api.cloudflare.com/client/v4/zones/${zone.zoneId}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${zone.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      return res.ok;
    } catch {
      // Never fail the caller's write path on a purge error.
      return false;
    }
  }

  /**
   * Purge from the edge (#392).
   *
   * Order matters:
   *
   *  1. `caches.default.delete` clears the colo running this code. Available
   *     everywhere, but **colo-local** — on its own it is not invalidation,
   *     because every other PoP keeps serving until `s-maxage`.
   *  2. Zone purge by **tag**, if the caller supplied tags. One call however
   *     many URLs are affected, and it reaches copies this process never
   *     recorded in its index.
   *  3. Zone purge by **URL**, if the tag call was rejected or no tags were
   *     given. Slower and limited to indexed URLs, but it does not depend on
   *     the account supporting tag purge.
   *
   * Falling back rather than choosing up-front is deliberate: whether tag
   * purge is available depends on the Cloudflare plan, which this code cannot
   * see. Trying it and degrading costs one failed request and removes the
   * need to configure the answer.
   */
  async purge(target: { urls: string[]; tags?: string[] }): Promise<number> {
    const urls = target.urls ?? [];
    const tags = target.tags ?? [];
    if (urls.length === 0 && tags.length === 0) return 0;

    let localPurged = 0;
    const cache = this.cache;
    if (cache) {
      for (const url of urls) {
        try {
          if (await cache.delete(new Request(url))) localPurged += 1;
        } catch {
          // Colo-local delete is best-effort.
        }
      }
    }

    if (!this.zonePurge) return localPurged;

    if (tags.length > 0) {
      let tagPurged = 0;
      let rejected = false;
      for (let i = 0; i < tags.length; i += PURGE_BATCH_SIZE) {
        const batch = tags.slice(i, i + PURGE_BATCH_SIZE);
        if (await this.zoneCall({ tags: batch })) tagPurged += batch.length;
        else rejected = true;
      }
      // Only fall through to URL purge when a tag call was refused — a
      // successful tag purge already covers more than the URL index does.
      if (!rejected) return Math.max(localPurged, tagPurged);
    }

    let zonePurged = 0;
    for (let i = 0; i < urls.length; i += PURGE_BATCH_SIZE) {
      const batch = urls.slice(i, i + PURGE_BATCH_SIZE);
      if (await this.zoneCall({ files: batch })) zonePurged += batch.length;
    }

    // The mechanisms overlap on the local colo, so report the largest rather
    // than a sum — this is an observability signal, not an accounting of
    // delete operations.
    return Math.max(localPurged, zonePurged);
  }
}
