import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHandler, type FlowRunContext } from '../flow-service';

/**
 * The `http` flow operation takes a user-supplied URL, so it must apply the
 * same SSRF policy as the extension sandbox's `http:fetch` capability:
 * loopback, private-range, link-local, and cloud-metadata targets are
 * rejected before any network call happens.
 */
describe('flow http operation — SSRF guard', () => {
  const httpHandler = getHandler('http')!;
  const ctx: FlowRunContext = { input: {}, steps: {}, env: {} };

  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('still requires a url', async () => {
    await expect(httpHandler(ctx, {})).rejects.toThrow(
      'http operation requires url',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['loopback host', 'http://localhost:1989/api/v1/items'],
    ['loopback IP', 'http://127.0.0.1:5432/'],
    ['private range', 'http://192.168.1.10/router'],
    ['private range (10.x)', 'http://10.0.0.5/internal'],
    ['private range (172.16-31)', 'http://172.16.0.10/metadata'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['metadata hostname', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['IPv6 loopback', 'http://[::1]/data'],
    ['IPv6 unique-local', 'http://[fd00::1]/metadata'],
  ])('blocks %s without calling fetch', async (_label, url) => {
    await expect(httpHandler(ctx, { url })).rejects.toThrow(
      /http operation blocked/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported protocol', 'file:///etc/passwd'],
    ['embedded credentials', 'https://user:pass@example.com/'],
  ])('blocks %s without calling fetch', async (_label, url) => {
    await expect(httpHandler(ctx, { url })).rejects.toThrow(
      /http operation blocked/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches an allowed public URL and returns status/ok/body', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => 'pong',
    });

    const result = await httpHandler(ctx, {
      url: 'https://example.com/api/ping',
      method: 'post',
      body: { hello: 'world' },
    });

    expect(result).toEqual({ status: 200, ok: true, body: 'pong' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [target, init] = fetchMock.mock.calls[0]!;
    expect((target as URL).href).toBe('https://example.com/api/ping');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe(JSON.stringify({ hello: 'world' }));
  });
});
