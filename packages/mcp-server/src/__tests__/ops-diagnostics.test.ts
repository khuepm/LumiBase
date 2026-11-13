import { afterEach, describe, expect, it, vi } from 'vitest';
import { LumiBaseClient, configFromEnv } from '../client.js';
import { registerAllTools } from '../tools/index.js';

const OPS_TOOLS = ['ops_diagnostics', 'ops_list_errors', 'ops_get_error', 'ops_probe_site'];

interface Captured {
  config: { annotations?: { readOnlyHint?: boolean } };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function fakeServer() {
  const tools = new Map<string, Captured>();
  return {
    tools,
    server: {
      registerTool(name: string, config: Captured['config'], handler: Captured['handler']) {
        if (tools.has(name)) throw new Error(`Duplicate tool name: ${name}`);
        tools.set(name, { config, handler });
      },
    },
  };
}

const client = (opsToken?: string) =>
  new LumiBaseClient({ url: 'https://api.example.test', siteId: 's1', token: 'lb_site_key', ...(opsToken ? { opsToken } : {}) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ops diagnostics tools', () => {
  it('are not registered without an ops token', () => {
    const { server, tools } = fakeServer();
    registerAllTools(server as never, client(), { dispatcher: null });
    for (const name of OPS_TOOLS) expect(tools.has(name)).toBe(false);
  });

  it('are registered, read-only, alongside content tools when an ops token is set', () => {
    const { server, tools } = fakeServer();
    registerAllTools(server as never, client('ops-secret'), { dispatcher: null });
    for (const name of OPS_TOOLS) {
      expect(tools.has(name), name).toBe(true);
      expect(tools.get(name)!.config.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.has('list_collections')).toBe(true);
  });

  it('ops-only mode registers only the ops tools', () => {
    vi.stubEnv('LUMIBASE_URL', 'https://api.example.test');
    vi.stubEnv('LUMIBASE_OPS_TOKEN', 'ops-secret');
    vi.stubEnv('LUMIBASE_TOKEN', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = configFromEnv();
    expect(config).toMatchObject({ opsOnly: true, readOnly: true });
    const { server, tools } = fakeServer();
    registerAllTools(server as never, new LumiBaseClient(config), { ...config, dispatcher: null });
    expect([...tools.keys()].sort()).toEqual([...OPS_TOOLS].sort());
  });

  it('call /api/v1/ops with the ops token and no site header', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { findings: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { server, tools } = fakeServer();
    registerAllTools(server as never, client('ops-secret'), { dispatcher: null });
    await tools.get('ops_probe_site')!.handler({ siteId: 'site_a' });
    await tools.get('ops_list_errors')!.handler({ status: 500, path: '/api/v1/site' });
    const [probeUrl, probeInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(probeUrl).toBe('https://api.example.test/api/v1/ops/sites/site_a/probe');
    expect(probeInit.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer ops-secret' });
    const [listUrl] = fetchMock.mock.calls[1] as unknown as [string];
    expect(listUrl).toBe('https://api.example.test/api/v1/ops/errors?status=500&path=%2Fapi%2Fv1%2Fsite');
  });

  it('explains the canonical 404 instead of reporting "Route not found."', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }), { status: 404 })),
    );
    const { server, tools } = fakeServer();
    registerAllTools(server as never, client('ops-secret'), { dispatcher: null });
    const res = await tools.get('ops_diagnostics')!.handler({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('OPS_PLANE_UNAVAILABLE');
  });
});
