import { describe, expect, it } from 'vitest';
import { NoOpEdgeCacheProvider } from '../adapters/docker/edge-cache';

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
});
