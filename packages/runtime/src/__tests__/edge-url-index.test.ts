import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '../memory-cache';
import { CloudflareEdgeCacheProvider } from '../adapters/cloudflare/edge-cache';
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
function createListableKv(opts?: { macrotaskYield?: boolean }): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  // Bulk tests (thousands of sequential writes) yield a microtask instead of a
  // timer turn; the concurrency tests keep the timer turn so writers interleave.
  const tick =
    opts?.macrotaskYield === false
      ? () => Promise.resolve()
      : () => new Promise<void>((resolve) => setTimeout(resolve, 0));
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

  for (const [name, factory] of providers) {
    it(`keeps the URLs indexed when the edge purge throws, so a retry purges them — ${name}`, async () => {
      const cache = factory();
      const urls = ['https://acme.test/a', 'https://acme.test/b'];
      for (const url of urls) await recordEdgeUrl(cache, ['deliver:site-a'], url, { ttl: 300 });

      const failing: EdgeCacheProvider = {
        ...fakeEdge(),
        async purge() {
          throw new Error('CDN purge API 503');
        },
      };
      expect(await purgeEdgeByTag(cache, failing, 'deliver:site-a')).toBe(0);

      const edge = fakeEdge();
      expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(2);
      expect([...(edge.purged[0] ?? [])].sort()).toEqual(urls);
      // Acknowledged after a successful purge: nothing left to retry.
      expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(0);
    });
  }

  it('Cloudflare: purges the newest 200 URLs even after more than 1000 writes under one tag', async () => {
    const cache = new CloudflareCacheProvider(createListableKv({ macrotaskYield: false }));
    const edge = fakeEdge();
    const total = 1100;
    let now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (let i = 0; i < total; i += 1) {
        now += 1;
        await recordEdgeUrl(cache, ['deliver:site-a'], `https://acme.test/p${i}`, { ttl: 300 });
      }
    } finally {
      spy.mockRestore();
    }

    expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(EDGE_URL_INDEX_LIMIT);
    const expected = Array.from({ length: EDGE_URL_INDEX_LIMIT }, (_, i) => `https://acme.test/p${total - EDGE_URL_INDEX_LIMIT + i}`);
    expect([...(edge.purged[0] ?? [])].sort()).toEqual([...expected].sort());
  });

  it('Cloudflare: reads the newest `limit` members, oldest first, and ack deletes them', async () => {
    const kv = createListableKv();
    const cache = new CloudflareCacheProvider(kv);
    let now = 1_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const m of ['a', 'b', 'c', 'b']) {
        now += 1;
        await cache.addMember('edgeurls:deliver:site-a', m, { ttl: 30 });
      }
    } finally {
      spy.mockRestore();
    }

    // `b` was re-added last, so it is the newest and is returned once.
    const first = await cache.readMembers('edgeurls:deliver:site-a', { limit: 2 });
    expect(first.members).toEqual(['c', 'b']);
    // Reading removes nothing until the batch is acknowledged.
    expect((await cache.readMembers('edgeurls:deliver:site-a', { limit: 2 })).members).toEqual(['c', 'b']);
    await first.ack();
    // `a` fell outside the bound and is left to expire on its TTL. The
    // earlier add of `b` was scanned before `a`, so the ack deleted it too.
    const rest = await cache.readMembers('edgeurls:deliver:site-a');
    expect(rest.members).toEqual(['a']);
    await rest.ack();
    expect((await cache.readMembers('edgeurls:deliver:site-a')).members).toEqual([]);
  });

  it('Cloudflare: clamps the member TTL to the KV minimum of 60 seconds', async () => {
    const kv = createListableKv();
    const put = vi.spyOn(kv, 'put');
    await new CloudflareCacheProvider(kv).addMember('k', 'm', { ttl: 30 });
    expect(put.mock.calls[0]?.[2]).toMatchObject({ expirationTtl: 60, metadata: { m: 'm' } });
  });

  it('purges URLs a pre-upgrade JSON list recorded, alongside the member set', async () => {
    const cache = new MemoryCacheProvider();
    const edge = fakeEdge();
    await cache.set(edgeUrlIndexKey('deliver:site-a'), JSON.stringify(['https://acme.test/old']));
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/new');

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');

    expect(edge.purged[0]).toEqual(['https://acme.test/old', 'https://acme.test/new']);
    expect(await cache.get(edgeUrlIndexKey('deliver:site-a'))).toBeNull();
  });

  it('a URL re-recorded while a purge is in flight stays indexed after the ack', async () => {
    const cache = new MemoryCacheProvider();
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');
    const batch = await cache.readMembers(edgeUrlIndexKey('deliver:site-a'));
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a');
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/b');

    await batch.ack();

    expect((await cache.readMembers(edgeUrlIndexKey('deliver:site-a'))).members).toEqual([
      'https://acme.test/a',
      'https://acme.test/b',
    ]);
  });

  it('Memory: honours the member-set TTL', async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCacheProvider();
      await cache.addMember('k', 'm', { ttl: 1 });
      vi.advanceTimersByTime(1_100);
      expect((await cache.readMembers('k')).members).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
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

/**
 * #864 review, second round — the shipped Cloudflare provider never throws:
 * a refused zone purge comes back as a count. The index must still keep the
 * URLs the CDN refused, so these tests use the real provider with the zone
 * API answering 4xx/5xx, not an edge double that throws.
 */
describe('edge URL index — zone purge refused by the CDN (#864)', () => {
  function zoneEdge(statuses: number[]): {
    edge: CloudflareEdgeCacheProvider;
    bodies: Array<Record<string, string[]>>;
  } {
    const bodies: Array<Record<string, string[]>> = [];
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, string[]>);
      const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
      call += 1;
      return new Response('{}', { status });
    });
    const edge = new CloudflareEdgeCacheProvider({
      zoneId: 'zone-1',
      apiToken: 'tok-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { edge, bodies };
  }

  const providers: Array<[string, () => CacheProvider]> = [
    ['MemoryCacheProvider', () => new MemoryCacheProvider()],
    ['CloudflareCacheProvider (listable KV)', () => new CloudflareCacheProvider(createListableKv())],
  ];

  for (const [name, factory] of providers) {
    it(`a 503 on tag and URL purge keeps every URL; the retry purges them — ${name}`, async () => {
      const cache = factory();
      const urls = ['https://acme.test/a', 'https://acme.test/b'];
      for (const url of urls) await recordEdgeUrl(cache, ['deliver:site-a'], url, { ttl: 300 });
      // Round 1: tag call 503, URL call 503. Round 2: tag call 403 (plan has
      // no tag purge), URL call 200.
      const { edge, bodies } = zoneEdge([503, 503, 403, 200]);

      expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(0);
      expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(2);

      expect(bodies[1]).toEqual({ files: urls });
      // The retry still carried both URLs: nothing was acknowledged on the 503.
      expect(bodies[3]).toEqual({ files: urls });
    });

    it(`a refused URL batch stays indexed while the accepted batch is acknowledged — ${name}`, async () => {
      const cache = factory();
      const urls = Array.from({ length: 35 }, (_, i) => `https://acme.test/p${String(i).padStart(2, '0')}`);
      for (const url of urls) await recordEdgeUrl(cache, ['deliver:site-a'], url, { ttl: 300 });
      // No tags accepted; first URL batch (30) 200, second batch (5) 500, then
      // everything succeeds.
      const { edge, bodies } = zoneEdge([403, 200, 500, 403, 200]);

      await purgeEdgeByTag(cache, edge, 'deliver:site-a');
      const refused = bodies[2]?.files ?? [];
      expect(refused).toHaveLength(5);

      await purgeEdgeByTag(cache, edge, 'deliver:site-a');
      expect([...(bodies[4]?.files ?? [])].sort()).toEqual([...refused].sort());
    });
  }

  it('a successful tag purge acknowledges every URL', async () => {
    const cache = new MemoryCacheProvider();
    await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/a', { ttl: 300 });
    const { edge, bodies } = zoneEdge([200]);

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');
    await purgeEdgeByTag(cache, edge, 'deliver:site-a');

    expect(bodies).toEqual([{ tags: ['deliver:site-a'] }, { tags: ['deliver:site-a'] }]);
    expect((await cache.readMembers(edgeUrlIndexKey('deliver:site-a'))).members).toEqual([]);
  });

  it('keeps a pre-upgrade JSON list while any of its URLs was refused', async () => {
    const cache = new MemoryCacheProvider();
    await cache.set(edgeUrlIndexKey('deliver:site-a'), JSON.stringify(['https://acme.test/old']));
    const { edge, bodies } = zoneEdge([403, 503, 403, 200]);

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');
    expect(await cache.get(edgeUrlIndexKey('deliver:site-a'))).not.toBeNull();

    await purgeEdgeByTag(cache, edge, 'deliver:site-a');
    expect(bodies[3]).toEqual({ files: ['https://acme.test/old'] });
    expect(await cache.get(edgeUrlIndexKey('deliver:site-a'))).toBeNull();
  });
});

/**
 * #864 review, second round — on Workers KV every add is a key. A URL that is
 * re-recorded on every edge miss must not leave one key per add, or its
 * copies fill the read's scan window and other recent URLs go unpurged.
 */
describe('edge URL index — Workers KV hot URL (#864)', () => {
  it('300 URLs then 1200 re-adds of one URL still purges the newest 200 distinct URLs', async () => {
    const cache = new CloudflareCacheProvider(createListableKv({ macrotaskYield: false }));
    const edge = fakeEdge();
    let now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const older: string[] = [];
    try {
      for (let i = 0; i < 300; i += 1) {
        now += 1;
        const url = `https://acme.test/p${i}`;
        older.push(url);
        await recordEdgeUrl(cache, ['deliver:site-a'], url, { ttl: 300 });
      }
      for (let i = 0; i < 1200; i += 1) {
        now += 1;
        await recordEdgeUrl(cache, ['deliver:site-a'], 'https://acme.test/hot', { ttl: 300 });
      }
    } finally {
      spy.mockRestore();
    }

    expect(await purgeEdgeByTag(cache, edge, 'deliver:site-a')).toBe(EDGE_URL_INDEX_LIMIT);
    expect(edge.purged[0]).toEqual([...older.slice(-(EDGE_URL_INDEX_LIMIT - 1)), 'https://acme.test/hot']);
  });

  it('a re-add replaces the member key instead of adding a second one', async () => {
    const kv = createListableKv();
    const cache = new CloudflareCacheProvider(kv);
    let now = 1_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await cache.addMember('k', 'm', { ttl: 300 });
      now += 5;
      await cache.addMember('k', 'm', { ttl: 300 });
    } finally {
      spy.mockRestore();
    }
    const listed = await kv.list?.({ prefix: 'lumi:set:k:' });
    expect(listed?.keys).toHaveLength(1);
  });
});
