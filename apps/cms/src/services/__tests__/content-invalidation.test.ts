import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider, recordEdgeUrl } from '@lumibase/runtime';
import type { EdgeCacheProvider } from '@lumibase/runtime';
import {
  deliverTag,
  invalidateDeliverTag,
  invalidateItemsTag,
  itemsTag,
} from '../content-invalidation';

describe('content invalidation — two-site isolation', () => {
  it('invalidating site A items tag does not purge site B entries (Req 8.6)', async () => {
    const cache = new MemoryCacheProvider();

    await cache.set(
      'deliver:site-a:home:0',
      JSON.stringify({ body: { page: 'a' }, etag: 'W/"a"' }),
      { ttl: 300, tags: [itemsTag('site-a', 'posts'), deliverTag('site-a')] },
    );
    await cache.set(
      'deliver:site-b:home:0',
      JSON.stringify({ body: { page: 'b' }, etag: 'W/"b"' }),
      { ttl: 300, tags: [itemsTag('site-b', 'posts'), deliverTag('site-b')] },
    );

    await invalidateItemsTag(cache, 'site-a', 'posts');

    await expect(cache.get('deliver:site-a:home:0')).resolves.toBeNull();
    await expect(cache.get('deliver:site-b:home:0')).resolves.toMatchObject({
      body: { page: 'b' },
      etag: 'W/"b"',
    });
  });
});

/**
 * #392 — a content write must reach the copy stored at the edge, not only the
 * application cache. Before this, `caches.default` held published pages with
 * no invalidation path at all and `s-maxage` was the only bound.
 */
describe('content invalidation — edge purge', () => {
  function edgeSpy(): EdgeCacheProvider & { purge: ReturnType<typeof vi.fn> } {
    const purge = vi.fn(async (target: { urls: string[]; tags?: string[] }) => target.urls.length);
    return {
      purge,
      match: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as EdgeCacheProvider & { purge: ReturnType<typeof vi.fn> };
  }

  it('purges the edge URLs recorded under the item tag', async () => {
    const cache = new MemoryCacheProvider();
    const edge = edgeSpy();
    const url = 'https://acme.test/api/v1/deliver/page/site-a/home';
    await recordEdgeUrl(cache, [itemsTag('site-a', 'posts'), deliverTag('site-a')], url);

    await invalidateItemsTag(cache, 'site-a', 'posts', edge);

    // Both addressing modes go out together: the tag for a CDN that supports
    // tag purge, the indexed URLs for one that does not.
    expect(edge.purge).toHaveBeenCalledWith({
      urls: [url],
      tags: [itemsTag('site-a', 'posts')],
    });
  });

  it('purges the edge on a schema apply (deliver tag)', async () => {
    const cache = new MemoryCacheProvider();
    const edge = edgeSpy();
    await recordEdgeUrl(cache, [deliverTag('site-a')], 'https://acme.test/a');

    await invalidateDeliverTag(cache, 'site-a', edge);

    expect(edge.purge).toHaveBeenCalledWith({
      urls: ['https://acme.test/a'],
      tags: [deliverTag('site-a')],
    });
  });

  it('never purges another tenant edge URL', async () => {
    const cache = new MemoryCacheProvider();
    const edge = edgeSpy();
    await recordEdgeUrl(cache, [itemsTag('site-a', 'posts')], 'https://acme.test/a');
    await recordEdgeUrl(cache, [itemsTag('site-b', 'posts')], 'https://acme.test/b');

    await invalidateItemsTag(cache, 'site-a', 'posts', edge);

    expect(edge.purge).toHaveBeenCalledOnce();
    // Neither the URL list nor the tag can reach site B.
    expect(edge.purge).toHaveBeenCalledWith({
      urls: ['https://acme.test/a'],
      tags: [itemsTag('site-a', 'posts')],
    });
  });

  it('still purges the application cache when the edge purge throws', async () => {
    const cache = new MemoryCacheProvider();
    const edge = {
      match: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      purge: vi.fn(async () => {
        throw new Error('zone api down');
      }),
    } as unknown as EdgeCacheProvider;

    await cache.set('deliver:site-a:home:0', JSON.stringify({ body: {}, etag: 'W/"a"' }), {
      ttl: 300,
      tags: [itemsTag('site-a', 'posts')],
    });
    await recordEdgeUrl(cache, [itemsTag('site-a', 'posts')], 'https://acme.test/a');

    await invalidateItemsTag(cache, 'site-a', 'posts', edge);

    // The layer we *can* invalidate is still invalidated — a failing edge
    // degrades to `s-maxage`, it does not block the app-cache purge.
    await expect(cache.get('deliver:site-a:home:0')).resolves.toBeNull();
  });

  it('is a no-op without an edge provider (Docker default)', async () => {
    const cache = new MemoryCacheProvider();
    await recordEdgeUrl(cache, [itemsTag('site-a', 'posts')], 'https://acme.test/a');

    await expect(invalidateItemsTag(cache, 'site-a', 'posts')).resolves.toBeUndefined();
  });
});
