import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '../memory-cache';
import {
  EDGE_URL_INDEX_LIMIT,
  edgeUrlIndexKey,
  purgeEdgeByTag,
  recordEdgeUrl,
} from '../edge-url-index';
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
