import { describe, expect, it, vi } from 'vitest';
import { McpUnavailableError, type LumiBaseClient } from '../client.js';
import {
  GOVERNED_TOOLS,
  GovernedDispatcher,
  UNGOVERNED_MUTATIONS,
  isMutationTool,
} from '../governed.js';
import { registerAllTools } from '../tools/index.js';

/**
 * `LUMIBASE_MCP_GOVERNED=on` must refuse mutations it cannot govern (reviewer R1).
 *
 * ## The defect this closes
 *
 * The registration wrapper only replaced a handler when `GOVERNED_TOOLS` had an
 * entry for the tool. Every other tool kept its REST handler — in **every** mode,
 * including `on`. So the setting whose only purpose is "never execute an
 * ungoverned write" governed the 27 mapped tools and let the other ~47 mutations
 * straight through to REST. Reproduced before the fix: with mode `on` and a
 * client that cannot answer JSON-RPC at all, `update_collection` issued
 * `PATCH /collections/posts`, reported success, and made zero JSON-RPC calls.
 *
 * `UNGOVERNED_MUTATIONS` listed the gap, but a list is documentation, not a gate.
 *
 * REST still applies RBAC and tenant scoping, so this was never an authorization
 * bypass. What it bypassed is the governance layer — autonomy gradient, HITL
 * approval, kill switch, `agent_runs` audit — which is precisely the contract
 * `on` is supposed to guarantee.
 *
 * ## Evidence class
 *
 * FAKE CMS transport: `LumiBaseClient` is a recorder, so "no REST side effect"
 * means "the handler issued no REST call". Registration, dispatch and the
 * handlers are the real ones. No DB, no network, no live CMS.
 *
 * **Validates: #454 — mode `on` is fail-closed for unmapped mutations, and the
 * refusal happens instead of the REST call, not after it**
 */

interface Captured {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * First text block of a tool result.
 *
 * `CallToolResult.content` is a union of block kinds, so indexing `.text`
 * directly does not typecheck. Narrowing here keeps each assertion readable.
 */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  return first && first.type === 'text' ? (first.text ?? '') : '';
}

interface RestCall {
  method: string;
  path: string;
}

/** A client that records REST calls and cannot answer JSON-RPC. */
function fakeClient(options: { jsonRpc?: 'unavailable' | 'ok' } = {}) {
  const rest: RestCall[] = [];
  const jsonRpcCalls: string[] = [];
  const record = (method: string) => (path: string) => {
    rest.push({ method, path });
    return Promise.resolve({ ok: true });
  };
  const client = {
    get: vi.fn(record('GET')),
    post: vi.fn(record('POST')),
    patch: vi.fn(record('PATCH')),
    put: vi.fn(record('PUT')),
    delete: vi.fn(record('DELETE')),
    getText: vi.fn(record('GET_TEXT')),
    getRootText: vi.fn(record('GET_ROOT')),
    postRaw: vi.fn(record('POST_RAW')),
    jsonRpc: vi.fn((method: string) => {
      jsonRpcCalls.push(method);
      if (options.jsonRpc === 'ok') {
        return Promise.resolve({
          structuredContent: { status: 'executed', message: 'done' },
        } as never);
      }
      return Promise.reject(new McpUnavailableError('contentOs.mcp is disabled'));
    }),
  };
  return { client: client as unknown as LumiBaseClient, rest, jsonRpcCalls };
}

function registry(mode: 'on' | 'auto' | 'off', jsonRpc?: 'unavailable' | 'ok') {
  const tools = new Map<string, Captured>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Captured['handler']) {
      tools.set(name, { handler });
    },
  };
  const { client, rest, jsonRpcCalls } = fakeClient(jsonRpc ? { jsonRpc } : {});
  const dispatcher = new GovernedDispatcher(client, { mode, warn: () => undefined });
  registerAllTools(server as never, client, { dispatcher });
  return { tools, rest, jsonRpcCalls };
}

describe('governed mode `on` — fail closed', () => {
  it('refuses an unmapped mutation and issues no REST call', async () => {
    // `update_collection` is `no-skill` in UNGOVERNED_MUTATIONS: there is nothing
    // to route it to. Before the fix this reached PATCH /collections/posts.
    const { tools, rest, jsonRpcCalls } = registry('on');
    const result = (await tools.get('update_collection')!.handler({
      name: 'posts',
      label: 'Posts',
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('has no governed mapping');
    expect(result.content[0]!.text).toContain('no-skill');
    expect(rest).toEqual([]);
    expect(jsonRpcCalls).toEqual([]);
  });

  it('refuses EVERY unmapped mutation in the inventory, with no REST side effect', async () => {
    // The whole inventory, not a sample: a fix that only covered the tools named
    // in the review would leave the rest exactly as they were.
    const { tools, rest } = registry('on');
    const unmappedMutations = [...tools.keys()].filter(
      (n) => isMutationTool(n) && GOVERNED_TOOLS[n] === undefined,
    );
    expect(unmappedMutations.length).toBeGreaterThan(40);

    const leaked: string[] = [];
    const notRefused: string[] = [];
    for (const name of unmappedMutations) {
      const before = rest.length;
      const res = (await tools.get(name)!.handler({ confirm: true })) as { isError?: boolean };
      if (res?.isError !== true) notRefused.push(name);
      if (rest.length !== before) leaked.push(name);
    }

    expect(notRefused).toEqual([]);
    expect(leaked).toEqual([]);
  });

  it('classifies and refuses a mutation that is in NEITHER table', async () => {
    // A mutation added tomorrow and forgotten in both tables must still be
    // refused. The inventory tripwire catches that in CI; the runtime gate is what
    // catches it if CI did not. Both halves of that gate are asserted here: the
    // classifier says "mutation", and the refusal names the missing decision
    // rather than quoting a reason that does not exist.
    expect(isMutationTool('delete_everything_new')).toBe(true);
    expect(GOVERNED_TOOLS['delete_everything_new']).toBeUndefined();
    expect(UNGOVERNED_MUTATIONS['delete_everything_new']).toBeUndefined();

    const { client, rest } = fakeClient();
    const dispatcher = new GovernedDispatcher(client, { mode: 'on', warn: () => undefined });
    const result = dispatcher.refuseUngoverned('delete_everything_new');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('neither the governed nor the declared-ungoverned');
    expect(rest).toEqual([]);
  });

  it('the classifier covers the verbs the inventory relies on', async () => {
    // `isMutationTool` is now load-bearing for a security gate, so its boundaries
    // are pinned rather than left to the regex's shape.
    for (const name of [
      'create_item',
      'update_collection',
      'delete_field',
      'upsert_setting',
      'revoke_api_key',
      'publish_release',
      'cdc_subscription_replay',
    ]) {
      expect(isMutationTool(name), `${name} is a mutation`).toBe(true);
    }
    for (const name of ['list_collections', 'get_item', 'search_items', 'health_check']) {
      expect(isMutationTool(name), `${name} is read-only`).toBe(false);
    }
  });

  it('refuses a MAPPED mutation when the governed endpoint is unavailable', async () => {
    // The other half of fail-closed: a tool that *can* be governed must not fall
    // back to REST in mode `on` just because the endpoint is down.
    const { tools, rest } = registry('on');
    const result = (await tools.get('delete_item')!.handler({
      collection: 'posts',
      id: 'i1',
      confirm: true,
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('contentOs.mcp');
    expect(rest).toEqual([]);
  });

  it('routes a mapped mutation through JSON-RPC when governance answers', async () => {
    // Positive path, so the refusals above cannot be satisfied by "refuse
    // everything".
    const { tools, rest, jsonRpcCalls } = registry('on', 'ok');
    const result = (await tools.get('delete_item')!.handler({
      collection: 'posts',
      id: 'i1',
      confirm: true,
    })) as { isError?: boolean };

    expect(result?.isError).not.toBe(true);
    expect(jsonRpcCalls).toContain('tools/call');
    expect(rest).toEqual([]);
  });

  it('leaves read-only tools alone in mode `on`', async () => {
    // Refusing reads would break the transport with no safety gain.
    const { tools, rest } = registry('on');
    await tools.get('list_collections')!.handler({});
    expect(rest.map((c) => c.method)).toEqual(['GET']);
  });

  it('mode `auto` still falls back to REST for unmapped mutations', async () => {
    // `auto` is documented as a convenience that announces its fallback. Changing
    // it here would break existing installs, which is why the gate is `on`-only.
    const { tools, rest } = registry('auto');
    await tools.get('update_collection')!.handler({ name: 'posts', label: 'Posts' });
    expect(rest).toEqual([{ method: 'PATCH', path: '/collections/posts' }]);
  });

  it('mode `off` is unchanged', async () => {
    const { tools, rest } = registry('off');
    await tools.get('update_collection')!.handler({ name: 'posts', label: 'Posts' });
    expect(rest).toEqual([{ method: 'PATCH', path: '/collections/posts' }]);
  });
});
