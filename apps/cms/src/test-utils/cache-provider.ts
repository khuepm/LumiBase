import {
  classifyCacheValue,
  MemoryCacheProvider,
  negativeCacheWireValue,
  type CacheEntry,
  type CacheProvider,
} from '@lumibase/runtime';

/**
 * Build a minimal CacheProvider for unit tests. Prefer
 * {@link MemoryCacheProvider} when TTL / negative-cache behaviour matters;
 * this helper wraps a plain Map for the common get/set/delete seed pattern.
 */
export function mapCacheProvider(seed: Record<string, string> = {}): CacheProvider {
  const store = new Map<string, string>(Object.entries(seed));
  const tagIndex = new Map<string, Set<string>>();
  return {
    get: async <T = string>(key: string) => {
      const entry = await (async (): Promise<CacheEntry<T>> => {
        const raw = store.get(key);
        if (raw === undefined) return { state: 'miss' };
        try {
          return classifyCacheValue<T>(JSON.parse(raw) as unknown);
        } catch {
          return { state: 'unavailable' };
        }
      })();
      return entry.state === 'hit' ? entry.value : null;
    },
    getEntry: async <T>(key: string): Promise<CacheEntry<T>> => {
      const raw = store.get(key);
      if (raw === undefined) return { state: 'miss' };
      try {
        return classifyCacheValue<T>(JSON.parse(raw) as unknown);
      } catch {
        return { state: 'unavailable' };
      }
    },
    set: async (key, value, options) => {
      store.set(key, value);
      if (options?.tags?.length) {
        for (const tag of options.tags) {
          let keys = tagIndex.get(tag);
          if (!keys) {
            keys = new Set();
            tagIndex.set(tag, keys);
          }
          keys.add(key);
        }
      }
    },
    setNegative: async (key, options) => {
      void options;
      store.set(key, negativeCacheWireValue());
    },
    delete: async (key) => {
      store.delete(key);
    },
    invalidateByTag: async (tag) => {
      const keys = tagIndex.get(tag);
      if (!keys) return;
      for (const key of keys) store.delete(key);
      tagIndex.delete(tag);
    },
    increment: async (key, by = 1) => {
      const next = Number(store.get(key) ?? '0') + by;
      store.set(key, String(next));
      return next;
    },
  };
}

export { MemoryCacheProvider };
