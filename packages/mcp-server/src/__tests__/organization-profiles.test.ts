import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LumiBaseClient, READ_ONLY_POST_PATHS, READ_ONLY_RPC_TOOLS, ReadOnlyViolationError, configFromEnv, type LumiBaseConfig } from '../client.js';
import { registerAllTools } from '../tools/index.js';

// Captured by running registerAllTools at epic commit 4f90a8e5541927012275d33f4c266eef42548b25.
// Keep independent of current registration so accidental site-tool additions/removals fail.
const legacy: string[] = JSON.parse(readFileSync(new URL('./legacy-site-tools.json', import.meta.url), 'utf8'));
const orgReads = ['get_organization', 'list_sites'];
const orgAll = [...orgReads, 'create_site', 'delete_site', 'transfer_site', 'list_org_members', 'invite_org_member', 'create_org_key'];
interface Tool { config: { inputSchema: Record<string, z.ZodType>; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }; handler: (args: Record<string, unknown>) => Promise<unknown> }
function capture(config: LumiBaseConfig) {
  const tools = new Map<string, Tool>();
  const server = { registerTool(name: string, config: Tool['config'], handler: Tool['handler']) {
    if (tools.has(name)) throw new Error(`duplicate ${name}`);
    tools.set(name, { config, handler });
  } };
  const client = new LumiBaseClient(config);
  registerAllTools(server as unknown as McpServer, client, { ...config, dispatcher: null });
  return { tools, client };
}
const profiles = [
  { label: 'site', config: { url: 'https://cms.test', token: 'lbk_test', siteId: 'site_a' }, extra: [] },
  { label: 'pinned organization', config: { url: 'https://cms.test', token: 'lbo_test', siteId: 'site_a' }, extra: orgReads },
  { label: 'unpinned organization', config: { url: 'https://cms.test', token: 'lbo_test' }, extra: orgAll },
];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('credential tool profiles', () => {
  it('keeps the original site tool metadata when read-only is off', () => {
    const { tools } = capture(profiles[0]!.config);
    expect(tools.get('list_items')!.config.annotations).toBeUndefined();
    expect(tools.get('create_item')!.config.annotations).toBeUndefined();
  });
  for (const profile of profiles) {
    it(`snapshots ${profile.label} names against the pre-Phase3 site baseline`, () => {
      const { tools } = capture(profile.config);
      expect([...tools.keys()].sort()).toEqual([...legacy, ...profile.extra].sort());
      expect([...tools.keys()].sort()).toMatchSnapshot();
      for (const [name, tool] of tools) {
        if (profile.label === 'unpinned organization' && legacy.includes(name)) {
          expect(tool.config.inputSchema.site?.safeParse(undefined).success).toBe(false);
        } else expect(tool.config.inputSchema.site).toBeUndefined();
      }
    });
    it(`filters ${profile.label} writes using annotations`, () => {
      const { tools } = capture({ ...profile.config, readOnly: true });
      expect(tools.has('list_items')).toBe(true);
      expect(tools.has('run_panel')).toBe(true);
      expect(tools.has('create_item')).toBe(false);
      expect(tools.has('create_org_key')).toBe(false);
      expect(tools.has('delete_site')).toBe(false);
      expect([...tools.values()].every((t) => t.config.annotations.readOnlyHint && !t.config.annotations.destructiveHint)).toBe(true);
      expect([...tools.keys()].sort()).toMatchSnapshot();
    });
  }
});
describe('LUMIBASE_READ_ONLY', () => {
  // Decided by what each tool actually sends, not by its name: the name-based
  // filter once let POST /agent/intents/:id/pause and POST /materialize through.
  const stateChanging = ['pause_intent', 'resume_intent', 'scan_intent', 'register_materialization'];
  for (const profile of profiles) {
    it(`${profile.label}: no exposed tool issues a state-changing request`, async () => {
      const { tools } = capture({ ...profile.config, readOnly: true });
      for (const name of stateChanging) expect(tools.has(name)).toBe(false);
      const sent: Array<{ tool: string; method: string; path: string; rpcTool?: string }> = [];
      for (const [tool, { handler }] of tools) {
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
          const path = String(url).replace('https://cms.test/api/v1', '');
          const rpc = path === '/mcp' && typeof init.body === 'string' ? JSON.parse(init.body) : null;
          sent.push({ tool, method: init.method ?? 'GET', path, rpcTool: rpc?.params?.name });
          return Response.json({ data: [{ id: 'org_a' }], result: { content: [] } });
        }));
        await handler({ site: 'site_a', id: 'x', collection: 'posts', name: 'n', key: 'k', slug: 's', panelId: 'p' })
          .catch(() => undefined);
      }
      const writes = sent.filter((r) => r.method !== 'GET').filter((r) => r.path === '/mcp'
        ? !READ_ONLY_RPC_TOOLS.has(String(r.rpcTool))
        : !(r.method === 'POST' && READ_ONLY_POST_PATHS.some((p) => p.test(r.path))));
      expect(writes).toEqual([]);
    });
  }
  it('refuses writes in the client even when a tool name hides one', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new LumiBaseClient({ url: 'https://cms.test', token: 'lbk_test', siteId: 'site_a', readOnly: true });
    await expect(client.post('/materialize', {})).rejects.toBeInstanceOf(ReadOnlyViolationError);
    await expect(client.delete('/items/posts/1')).rejects.toBeInstanceOf(ReadOnlyViolationError);
    await expect(client.jsonRpc('tools/call', { name: 'org:create_site', arguments: {} }, { organization: true }))
      .rejects.toBeInstanceOf(ReadOnlyViolationError);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.post('/permissions/check', {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
it('keeps concurrent unpinned site calls isolated and strips the routing argument', async () => {
  const calls: Array<{ url: string; site: string | undefined }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, url.includes('posts') ? 5 : 1));
    calls.push({ url, site: (init.headers as Record<string, string>)['X-Lumi-Site'] });
    return Response.json({ data: [] });
  }));
  const { tools, client } = capture({ url: 'https://cms.test', token: 'lbo_test' });
  await Promise.all([
    tools.get('list_items')!.handler({ site: 'site_a', collection: 'posts' }),
    tools.get('list_items')!.handler({ site: 'site_b', collection: 'pages' }),
  ]);
  expect(calls.find((c) => c.url.includes('/posts'))?.site).toBe('site_a');
  expect(calls.find((c) => c.url.includes('/pages'))?.site).toBe('site_b');
  expect(calls.every((c) => !c.url.includes('site='))).toBe(true);
  await client.get('/items/other', 'site_c');
  expect(calls.at(-1)?.site).toBe('site_c');
});
it('org writes use governed RPC without a site header or confirm escape', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return url.endsWith('/orgs') ? Response.json({ data: [{ id: 'org_a' }] })
      : Response.json({ result: { content: [{ type: 'text', text: 'approval needed' }], structuredContent: { status: 'pending_approval', organizationId: 'org_a', approvalId: 'approval_a' } } });
  }));
  const { tools, client } = capture({ url: 'https://cms.test', token: 'lbo_test' });
  const result = await client.withSite('site_a', () => tools.get('create_site')!.handler({ name: 'New', confirm: true }));
  expect(result).toMatchObject({ structuredContent: { status: 'pending_approval', organizationId: 'org_a' } });
  expect(requests.map((r) => r.url)).toEqual(['https://cms.test/api/v1/orgs', 'https://cms.test/api/v1/mcp']);
  expect(requests.every((r) => !(r.init.headers as Record<string, string>)['X-Lumi-Site'])).toBe(true);
  const rpc = JSON.parse(String(requests[1]!.init.body));
  expect(rpc.params).toEqual({ name: 'org:create_site', arguments: { name: 'New', organizationId: 'org_a' } });
});
it('never falls back to REST for an org mutation when MCP is disabled', async () => {
  vi.stubEnv('LUMIBASE_MCP_GOVERNED', 'off');
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/orgs')
    ? Response.json({ data: [{ id: 'org_a' }] })
    : Response.json({ errors: [{ code: 'MCP_DISABLED' }] }, { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  const { tools } = capture({ url: 'https://cms.test', token: 'lbo_test' });
  expect(await tools.get('create_org_key')!.handler({ name: 'Key', confirm: true })).toMatchObject({ isError: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('allows an unpinned lbo_ config but retains the site-token startup requirement', () => {
  vi.stubEnv('LUMIBASE_URL', 'https://cms.test'); vi.stubEnv('LUMIBASE_TOKEN', 'lbo_test');
  vi.stubEnv('LUMIBASE_SITE_ID', ''); vi.stubEnv('LUMIBASE_READ_ONLY', 'true');
  expect(configFromEnv()).toMatchObject({ tokenKind: 'organization', readOnly: true });
  expect(configFromEnv().siteId).toBeUndefined();
  vi.stubEnv('LUMIBASE_TOKEN', 'lbk_test');
  expect(() => configFromEnv()).toThrow('LUMIBASE_SITE_ID');
});
