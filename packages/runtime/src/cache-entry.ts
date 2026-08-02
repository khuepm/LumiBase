import {
  isNegativeCacheEnvelope,
  NEGATIVE_CACHE_ENVELOPE,
  type CacheEntry,
} from './interfaces/cache';

/**
 * Classify a raw JSON-parsed cache value into a {@link CacheEntry}.
 * Shared by Redis/KV/memory adapters so the envelope contract stays in one place.
 */
export function classifyCacheValue<T>(raw: unknown): CacheEntry<T> {
  if (raw === null || raw === undefined) return { state: 'miss' };
  if (isNegativeCacheEnvelope(raw)) return { state: 'negative' };
  return { state: 'hit', value: raw as T };
}

/** Serialise the tombstone envelope for `CacheProvider.set`. */
export function negativeCacheWireValue(): string {
  return JSON.stringify(NEGATIVE_CACHE_ENVELOPE);
}
