import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import {
  deliverTag,
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
