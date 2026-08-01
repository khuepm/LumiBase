/**
 * Negative-cache (tombstone) key helpers + shared resolve wiring
 * (high-load-cache-readiness Req 19.5–19.8; design §14.4–14.5).
 */

import {
  createNegativeCache,
  type CacheProvider,
  type NegativeCache,
} from '@lumibase/runtime';
import { normalizeSlugForKey } from './identifier-guard';

export const DEFAULT_NEGATIVE_CACHE_TTL = 30;
export const NEGATIVE_KEY_MAXLEN = 256;

export function negativePageKey(siteId: string, slug: string): string {
  return `neg:${siteId}:page:${normalizeSlugForKey(slug, NEGATIVE_KEY_MAXLEN)}`;
}

export function negativeCollectionKey(siteId: string, name: string): string {
  return `neg:${siteId}:collection:${name}`;
}

export function negativeItemKey(siteId: string, collection: string, id: string): string {
  return `neg:${siteId}:item:${collection}:${id}`;
}

/** Site-level tombstone — flat namespace (design §14.5 / §17 exception). */
export function negativeSiteKey(siteId: string): string {
  return `neg:site:${siteId}`;
}

export function resolveNegativeTtl(env: { LUMIBASE_NEGATIVE_CACHE_TTL?: string } | undefined): number {
  const raw = env?.LUMIBASE_NEGATIVE_CACHE_TTL;
  if (raw === undefined || raw === '') return DEFAULT_NEGATIVE_CACHE_TTL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_NEGATIVE_CACHE_TTL;
  return n;
}

export type NegativeHitWriteHooks = {
  onNegativeHit?: (key: string) => void;
  onNegativeWrite?: (key: string) => void;
};

export function buildNegativeCache(
  cache: CacheProvider,
  ttl: number,
  hooks?: NegativeHitWriteHooks,
): NegativeCache {
  return createNegativeCache({
    cache,
    ttl,
    onNegativeHit: hooks?.onNegativeHit,
    onNegativeWrite: hooks?.onNegativeWrite,
  });
}

/**
 * Best-effort tombstone delete after a resource is created (Req 19.7).
 * Errors → warn only; never fail the write request (same policy as tag purge).
 */
export async function forgetNegative(
  cache: CacheProvider | undefined,
  key: string,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(key);
  } catch (err) {
    console.warn('[cache] negative forget failed', { key, err });
  }
}
