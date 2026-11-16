import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '../memory-cache';
import { CloudflareCacheProvider, type KVNamespace } from '../adapters/cloudflare/cache';
import {
  EDGE_URL_INDEX_LIMIT,
  edgeUrlIndexKey,
  purgeEdgeByTag,
  recordEdgeUrl,
} from '../edge-url-index';
import type { CacheProvider } from '../interfaces/cache';
import type { EdgeCacheProvider } from '../interfaces/edge-cache';

function fakeEdge(): EdgeCacheProvider & { purged: string[][] } {
  const purged: string[][] = [];
  return {
    purged,
    async match() {
      return null;
    },
    async put() {
      // no-op
    },
    async purge(target: { urls: string[]; tags?: string[] }) {
      purged.push(target.urls);
      return target.urls.length;
    },
  };
}

/**
 * In-memory Workers KV stand-in that implements `list` with metadata, like the
 * real binding. Every call yields to the event loop, so concurrent callers
 * interleave the way they do against the real (remote) KV.
 */
function createListableKv(): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  async function get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    await tick();
    const raw = store.get(key)?.value;
    if (raw === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }
    return raw;
  }
  return {
    get: get as KVNamespace['get'],
    async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }) {
      await tick();
      store.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      await tick();
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      await tick();
      const names = [...store.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const end = start + (options?.limit ?? 1000);
      const page = names.slice(start, end);
      return {
        keys: page.map((name) => ({ name, metadata: store.get(name)?.metadata })),
        list_complete: end >= names.length,
        ...(end < names.length ? { cursor: String(end) } : {}),
      };
    },
  } as KVNamespace;
}

/**
 * #864 — recording a URL must not be a read-modify-write of one shared list:
 * two cache misses for different URLs under the same tag would each read the
 * old list and the slower write would drop the other URL from the index.
 */
describe('edge URL index — concurrent writers (#864)', () => {
  const providers: Array<[string, () => CacheProvider]> = [
    ['MemoryCacheProvider', () => new MemoryCacheProvider()],
    ['CloudflareCacheProvider (listable KV)', () => new CloudflareCacheProvider(createListableKv())],
  ];

  for (const [name, factory] of providers) {
    it(`keeps every URL recorded concurrently under one tag — ${name}`, async () => {
      const cache = factory();
      const edge = fakeEdge();
      const urls = Array.from({ length: 8 }, (_, i) => `https://acme.test/api/v1/deliver/page/site-a/p${i}`);

      await Promise.all(urls.map((url) => recordEdgeUrl(cache, ['deliver:site-a'], url, { ttl: 300 })));

      expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(urls.length);
      expect([...(edge.purged[0] ?? [])].sort()).toEqual([...urls].sort());
    });
  }
});

/**
 * #392 — LumiBase keeps its own tag→URL index so edge invalidation works even
 * where the CDN cannot purge by tag. The provider is handed both the tag and
 * the indexed URLs and decides which mechanism it can use.
 */
describe('edge URL index', () => {
  it('records a URL under every tag and purges them all back', async () => {
    const cache = new MemoryCacheProvider();
    const edge = fakeEdge();
    const url = 'https://acme.test/api/v1/deliver/page/site-a/home';

    await recordEdgeUrl(cache, ['deliver:site-a', 'items:site-a:posts'], url);

    expect(await purgeEdgeByTag(cache, edge, 'items:site-a:posts')).toBe(1);
    expect(edge.purged).toEqual([[url]]);
  });

  it('drops the index entry after a purge so the next one does not retry dead URLs', async () => {
    const cache = new MemoryCacheProvider();
    const edge = fakeEdge();
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');

    expect(await cache.get(edgeUrlIndexKey('deliver:site-a'))).toBeNull();
    // The second purge still reaches the provider — a CDN that supports tag
    // purge can act on copies this index never recorded — but it carries no
    // URLs, so the dead ones from the first round are not retried.
    expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(0);
    expect(edge.purged).toEqual([['https://acme.test/a'], []]);
  });

  it('never lets site A purge reach a URL indexed for site B', async () => {
    const cache = new MemoryCacheProvider();
    const edge = fakeEdge();
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');
    await recordEdgeUrl(cache, ['deliver:site-b'], 'https://acme.test/b');

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');

    expect(edge.purged).toEqual([['https://acme.test/a']]);
    // Site B's index is untouched — tags carry `siteId`, so neither the tag
    // nor the URL list can cross tenants.
    expect(await purgeEdgeByTag(cache, edge, 'deliver:site-b')).toBe(1);
    expect(edge.purged[1]).toEqual(['https://acme.test/b']);
  });

  it('does not duplicate a URL recorded twice', async () => {
    const cache = new MemoryCacheProvider();
    const edge = fakeEdge();
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');

    expect(edge.purged[0]).toEqual(['https://acme.test/a']);
  });

  it('caps the list and keeps the newest URLs', async () => {
    const cache = new MemoryCacheProvider();
    const edge = fakeEdge();
    for (let i = 0; i < 5; i += 1) {
      await recordEdgeUrl(cache, ['deliver:site-a'], `https://acme.test/${i}`, { limit: 3 });
    }

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');

    expect(edge.purged[0]).toEqual([
      'https://acme.test/2',
      'https://acme.test/3',
      'https://acme.test/4',
    ]);
  });

  it('exposes a bounded default limit', () => {
    expect(EDGE_URL_INDEX_LIMIT).toBeGreaterThan(0);
    expect(Number.isFinite(EDGE_URL_INDEX_LIMIT)).toBe(true);
  });

  it('is a no-op without an edge provider, and never throws on a broken cache', async () => {
    const cache = new MemoryCacheProvider();
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');

    expect(await purgeEdgeByTag(cache, null, 'deliver:site-a')).toBe(0);

    const broken = {
      get: vi.fn(async () => {
        throw new Error('backend down');
      }),
      set: vi.fn(async () => {
        throw new Error('backend down');
      }),
      delete: vi.fn(async () => undefined),
    } as unknown as MemoryCacheProvider;

    // Index maintenance must never fail the response it describes, and a purge
    // that cannot read its index degrades to "expires on s-maxage".
    await expect(
      recordEdgeUrl(broken, ['deliver:site-a'], 'https://acme.test/a'),
    ).resolves.toBeUndefined();
    expect(await purgeEdgeByTag(broken, fakeEdge(), 'deliver:site-a')).toBe(0);
  });
});
