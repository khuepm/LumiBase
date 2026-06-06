import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchRevalidation } from '../revalidation';

describe('dispatchRevalidation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches active targets through the guarded fetch path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const results = await dispatchRevalidation(
      [{ id: 'prod', label: 'Production', url: 'https://example.com/api/revalidate', status: 'active' }],
      ['posts'],
    );

    expect(results).toEqual([{ targetId: 'prod', tag: 'posts', ok: true, status: 200 }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://example.com/api/revalidate?tag=posts' }),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('blocks private revalidation targets before fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const results = await dispatchRevalidation(
      [{ id: 'internal', label: 'Internal', url: 'http://169.254.169.254/latest', status: 'active' }],
      ['posts'],
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ targetId: 'internal', tag: 'posts', ok: false });
    expect(results[0]?.error).toContain('blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
