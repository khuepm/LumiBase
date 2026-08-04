import type { EdgeCacheProvider } from '../../interfaces/edge-cache';

/**
 * Minimal Cache Storage API surface (Cloudflare Workers `caches.default`).
 * Declared locally to avoid importing @cloudflare/workers-types in business code.
 */
interface EdgeCacheStorage {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

declare const caches: { default: EdgeCacheStorage } | undefined;

/** Thin adapter around the Workers Cache API (`caches.default`). */
export class CloudflareEdgeCacheProvider implements EdgeCacheProvider {
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
}
