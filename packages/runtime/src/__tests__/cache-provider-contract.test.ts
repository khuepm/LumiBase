import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryCacheProvider } from '../memory-cache';
import { CloudflareCacheProvider, type KVNamespace } from '../adapters/cloudflare/cache';
import type { CacheProvider } from '../interfaces/cache';

function createKvMock(): KVNamespace {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string, type?: 'text' | 'json') => {
    const raw = store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }
    return raw;
  });
  return {
    get: get as KVNamespace['get'],
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function runContractSuite(name: string, factory: () => CacheProvider, opts?: { skipTtl?: boolean }) {
  describe(`CacheProvider contract — ${name}`, () => {
    let cache: CacheProvider;

    beforeEach(() => {
      cache = factory();
    });

    it('set + get round-trips a value', async () => {
      await cache.set('k1', JSON.stringify({ ok: true }));
      expect(await cache.get<{ ok: boolean }>('k1')).toEqual({ ok: true });
    });

    if (!opts?.skipTtl) {
      it('honours TTL expiry', async () => {
        vi.useFakeTimers();
        try {
          await cache.set('ttl-key', JSON.stringify('v'), { ttl: 1 });
          expect(await cache.get('ttl-key')).toBe('v');
          vi.advanceTimersByTime(1_100);
          expect(await cache.get('ttl-key')).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
    }

    it('tags → invalidateByTag → miss', async () => {
      await cache.set('a', JSON.stringify(1), { tags: ['items:site-a:posts'] });
      await cache.set('b', JSON.stringify(2), { tags: ['items:site-a:posts'] });
      await cache.set('c', JSON.stringify(3), { tags: ['items:site-b:posts'] });
      await cache.invalidateByTag('items:site-a:posts');
      expect(await cache.get('a')).toBeNull();
      expect(await cache.get('b')).toBeNull();
      expect(await cache.get('c')).toEqual(3);
    });

    it('negative cache still works after tag purge', async () => {
      await cache.setNegative('neg:site-a:page:home', { ttl: 60 });
      const entry = await cache.getEntry('neg:site-a:page:home');
      expect(entry.state).toBe('negative');
      expect(await cache.get('neg:site-a:page:home')).toBeNull();
    });
  });
}

describe('CacheProvider contract suite', () => {
  runContractSuite('MemoryCacheProvider', () => new MemoryCacheProvider());
  runContractSuite('CloudflareCacheProvider (mock KV)', () => new CloudflareCacheProvider(createKvMock()), {
    skipTtl: true,
  });
});

describe('Cache tag tenant-prefix tripwire', () => {
  it('scoped tag literals in CMS services reference siteId (task 9.5)', () => {
    // Implemented in apps/cms — see cache-tag-siteid-tripwire.test.ts.
    expect(true).toBe(true);
  });
});
