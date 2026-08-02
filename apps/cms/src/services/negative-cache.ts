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

/**
 * Collection-name tombstone key.
 *
 * The name is clamped like the page slug: `SAFE_FIELD_NAME` bounds the
 * *alphabet* but not the *length*, so an authenticated caller probing
 * `GET /items/<10KB name>` would otherwise mint 10KB Redis keys. Clamping is
 * safe for key material — two names sharing a 256-char prefix collapsing to one
 * tombstone only costs an extra DB probe for the longer name, and no real
 * collection name approaches that bound (schema create caps at 63 chars).
 */
export function negativeCollectionKey(siteId: string, name: string): string {
  return `neg:${siteId}:collection:${clampKeyPart(name)}`;
}

/*
 * There is deliberately no `negativeItemKey`. Design §14.5 sketched
 * `neg:{site}:item:{collection}:{id}`, but every item-by-id read sits behind
 * auth and Req 19.8 forbids serving a tombstone to a credentialed request — so
 * the read side can never be wired, and a write-only key is dead weight. Revisit
 * only if a public, unauthenticated item-by-id surface ships.
 */

/** Bound attacker-influenced key material (see {@link negativeCollectionKey}). */
function clampKeyPart(value: string): string {
  return value.length > NEGATIVE_KEY_MAXLEN ? value.slice(0, NEGATIVE_KEY_MAXLEN) : value;
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
