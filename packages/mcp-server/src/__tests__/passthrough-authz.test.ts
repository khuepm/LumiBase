import { afterEach, describe, expect, it, vi } from 'vitest';
import { LumiBaseClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';

const cases = [
  ['export_backup', {}, 'GET', '/admin/backup'],
  ['restore_backup', { ndjson: '{"type":"__meta__"}', confirm: true }, 'POST', '/admin/restore'],
  ['install_marketplace_extension', { slug: 'example' }, 'POST', '/marketplace/extensions/example/install'],
  ['list_media', {}, 'GET', '/media'],
  ['delete_media', { key: 'asset.bin', confirm: true }, 'DELETE', '/media/asset.bin'],
] as const;

describe('#580 standalone REST passthrough credentials and refusals', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(cases)('%s preserves tenant/token and surfaces refusal without retry', async (name, input, method, path) => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const server = { registerTool: (key: string, _config: unknown, handler: (args: unknown) => Promise<unknown>) => handlers.set(key, handler) };
    registerAllTools(server as never, new LumiBaseClient({ url: 'https://cms.example.test', siteId: 'site-a', token: 'synthetic-token' }));
    const fetcher = vi.fn(async (_url: unknown, _options: unknown) => new Response(JSON.stringify({ errors: [{ code: 'FORBIDDEN', message: 'revoked' }] }), { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await handlers.get(name)!(input);
    expect(result).toMatchObject({ isError: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1${path}`);
    expect(options).toMatchObject({ method, headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token', 'X-Lumi-Site': 'site-a' }) });
  });
});
