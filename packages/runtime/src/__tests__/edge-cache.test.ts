import { describe, expect, it, vi } from 'vitest';
import { NoOpEdgeCacheProvider } from '../adapters/docker/edge-cache';
import { CloudflareEdgeCacheProvider } from '../adapters/cloudflare/edge-cache';

describe('NoOpEdgeCacheProvider', () => {
  const provider = new NoOpEdgeCacheProvider();
  const request = new Request('https://example.com/api/v1/deliver/page/site-a/home');

  it('always misses', async () => {
    expect(await provider.match(request)).toBeNull();
  });

  it('put is a no-op', async () => {
    await expect(
      provider.put(request, new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ).resolves.toBeUndefined();
    expect(await provider.match(request)).toBeNull();
  });

  it('purges nothing — there is no edge in front of Docker by default', async () => {
    expect(
      await provider.purge({ urls: ['https://example.com/a'], tags: ['deliver:site-a'] }),
    ).toBe(0);
  });
});

/**
 * #392 — the zone purge API is what reaches PoPs other than the one running
 * this code (`caches.default.delete` is colo-local). The provider is given
 * both a tag and the indexed URLs, tries the tag first because it is one call
 * and covers more, and falls back to URLs when the account refuses it.
 */
describe('CloudflareEdgeCacheProvider.purge', () => {
  const urls = ['https://acme.test/api/v1/deliver/page/site-a/home'];

  it('does not call the zone API when no credentials are configured', async () => {
    const fetchImpl = vi.fn();
    const provider = new CloudflareEdgeCacheProvider(undefined);

    // `caches` is undefined outside Workers, so this exercises the degraded
    // path: nothing to purge locally, no zone call, no throw.
    expect(await provider.purge({ urls })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the URLs to the zone purge endpoint with the bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'zone-1',
      apiToken: 'tok-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.purge({ urls })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(init.body as string)).toEqual({ files: urls });
  });

  it('batches beyond the 30-URL single-file purge limit', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
    const many = Array.from({ length: 65 }, (_, i) => `https://acme.test/p/${i}`);
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'z',
      apiToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.purge({ urls: many })).toBe(65);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never throws when the zone API fails — the write path must not fail', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'z',
      apiToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.purge({ urls })).toBe(0);
  });

  it('reports 0 for an HTTP error response rather than claiming success', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"success":false}', { status: 403 }));
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'z',
      apiToken: 'bad',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.purge({ urls })).toBe(0);
  });

  it('skips the call entirely for an empty URL list', async () => {
    const fetchImpl = vi.fn();
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'z',
      apiToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.purge({ urls: [] })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prefers a single tag call over per-URL purging when tags are supplied', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'z',
      apiToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.purge({ urls: ['https://a/1', 'https://a/2'], tags: ['items:site-a:posts'] });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ tags: ['items:site-a:posts'] });
  });

  it('falls back to URL purge when the tag call is refused', async () => {
    // Whether tag purge is allowed depends on the account's plan, which this
    // code cannot see — so it tries, and degrades on refusal (#392).
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
      return 'tags' in body
        ? new Response('{"success":false}', { status: 403 })
        : new Response('{"success":true}', { status: 200 });
    });
    const provider = new CloudflareEdgeCacheProvider({
      zoneId: 'z',
      apiToken: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(
      await provider.purge({ urls: ['https://a/1'], tags: ['items:site-a:posts'] }),
    ).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, second] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(second.body as string)).toEqual({ files: ['https://a/1'] });
  });
});
