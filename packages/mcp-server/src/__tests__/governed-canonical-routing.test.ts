import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LumiBaseClient } from '../client.js';
import { GOVERNED_TOOLS, GovernedDispatcher, UNGOVERNED_MUTATIONS } from '../governed.js';
import { registerAllTools } from '../tools/index.js';

/**
 * The six tools routed once their skills got a canonical contract (#454
 * follow-up: the `no-canonical-contract` group).
 *
 * What each case pins, per tool:
 *   1. the call reaches `POST /api/v1/mcp` `tools/call` under the right skill
 *      name, and no REST mutation is issued;
 *   2. the arguments arrive under the names the skill reads — snake_case →
 *      camelCase, the one explicit rename, `confirm` dropped;
 *   3. an argument the contract does not know is FORWARDED, not dropped, so the
 *      harness's strict schema can refuse it. The refusal itself is proven on the
 *      CMS side (`g2-agent-tool-schemas.test.ts`), which can import the live Zod;
 *      here the fixture stands in for it, and a `denied`/`VALIDATION` reply is
 *      rendered as an error rather than a success.
 *
 * EVIDENCE CLASS: fake CMS transport. `LumiBaseClient` is a recorder; the
 * registration wrapper, dispatcher and `toSkillArgs` are the real ones. No DB,
 * no network, no live CMS.
 */

interface CanonicalEntry {
  properties: string[];
  required: string[];
}

const canonical = JSON.parse(
  readFileSync(join(import.meta.dirname, 'canonical-agent-tool-schemas.json'), 'utf8'),
) as Record<string, CanonicalEntry>;

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

type Decision = Record<string, unknown>;

/** A CMS whose governed endpoint answers, recording REST and JSON-RPC traffic. */
function governedCms(decision: Decision = { status: 'executed', data: { ok: true } }) {
  const calls: Recorded[] = [];
  const record = (method: string) => (path: string, body?: unknown) => {
    calls.push({ method, path, body });
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
    jsonRpc: vi.fn((method: string, params?: Record<string, unknown>) => {
      calls.push({ method: 'JSONRPC', path: method, body: params });
      if (method === 'tools/list') return Promise.resolve({ tools: [] });
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(decision) }],
        structuredContent: decision,
        isError: decision['status'] === 'denied',
      });
    }),
  };
  return { client: client as unknown as LumiBaseClient, calls };
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function governedRegistry(decision?: Decision) {
  const { client, calls } = governedCms(decision);
  const handlers = new Map<string, Handler>();
  registerAllTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
    } as never,
    client,
    { dispatcher: new GovernedDispatcher(client, { mode: 'on', warn: () => undefined }) },
  );
  return { handlers, calls };
}

function toolsCalls(calls: Recorded[]): Array<{ name: string; arguments: Record<string, unknown> }> {
  return calls
    .filter((c) => c.method === 'JSONRPC' && c.path === 'tools/call')
    .map((c) => c.body as { name: string; arguments: Record<string, unknown> });
}

const REST_MUTATIONS = new Set(['POST', 'PATCH', 'PUT', 'DELETE', 'POST_RAW']);

/**
 * One realistic call per newly governed tool, with the arguments the skill must
 * receive. Values are what an assistant would plausibly send, not placeholders,
 * so a translation bug on a nested value would show up too.
 */
const CASES: Array<{
  tool: string;
  skill: string;
  args: Record<string, unknown>;
  expected: Record<string, unknown>;
}> = [
  {
    tool: 'create_relation',
    skill: 'createRelation',
    args: {
      manyCollection: 'posts',
      manyField: 'author',
      oneCollection: 'authors',
      type: 'm2o',
      onDelete: 'set null',
      meta: { note: 'byline' },
    },
    expected: {
      manyCollection: 'posts',
      manyField: 'author',
      oneCollection: 'authors',
      type: 'm2o',
      onDelete: 'set null',
      meta: { note: 'byline' },
    },
  },
  {
    tool: 'create_intent',
    skill: 'createIntent',
    args: {
      name: 'Fresh news',
      collection: 'posts',
      rules: [{ type: 'freshness', maxAgeDays: 30 }],
      schedule: '0 * * * *',
      autonomyCap: 1,
    },
    expected: {
      name: 'Fresh news',
      collection: 'posts',
      rules: [{ type: 'freshness', maxAgeDays: 30 }],
      schedule: '0 * * * *',
      autonomyCap: 1,
    },
  },
  {
    tool: 'update_translation',
    skill: 'updateTranslation',
    args: { id: 'tr_1', value: 'Xin chào', status: 'published' },
    expected: { id: 'tr_1', value: 'Xin chào', status: 'published' },
  },
  {
    tool: 'create_webhook',
    skill: 'createWebhook',
    args: {
      name: 'Rebuild site',
      url: 'https://hooks.example.com/rebuild',
      actions: ['create', 'update'],
      collections: ['posts'],
      headers: { 'x-token': 'abc' },
      status: 'active',
      secret: null,
    },
    expected: {
      name: 'Rebuild site',
      url: 'https://hooks.example.com/rebuild',
      actions: ['create', 'update'],
      collections: ['posts'],
      headers: { 'x-token': 'abc' },
      status: 'active',
      secret: null,
    },
  },
  {
    tool: 'update_webhook',
    skill: 'updateWebhook',
    args: { id: 'wh_1', status: 'inactive' },
    // Only what the caller sent. The REST route re-applies its defaults on PATCH
    // (see the out-of-scope backlog); the skill receives the partial patch as is.
    expected: { id: 'wh_1', status: 'inactive' },
  },
  {
    tool: 'delete_cdc_subscription',
    skill: 'deleteCdcSubscription',
    args: { id: 'sub_1', confirm: true },
    // `id` → `subscriptionId` (explicit rename), `confirm` dropped.
    expected: { subscriptionId: 'sub_1' },
  },
];

describe('newly governed tools · routing', () => {
  it('covers exactly the tools this change routed, each with a canonical contract', () => {
    expect(CASES.map((c) => c.tool).sort()).toEqual(
      [
        'create_intent',
        'create_relation',
        'create_webhook',
        'delete_cdc_subscription',
        'update_translation',
        'update_webhook',
      ].sort(),
    );
    for (const { tool, skill } of CASES) {
      expect(GOVERNED_TOOLS[tool]?.skill, tool).toBe(skill);
      expect(UNGOVERNED_MUTATIONS[tool], `${tool} is in exactly one table`).toBeUndefined();
      expect(canonical[skill], `${skill} has a canonical contract`).toBeDefined();
    }
  });

  for (const { tool, skill, args, expected } of CASES) {
    it(`${tool} → ${skill}: arguments arrive under the skill's names, no REST mutation`, async () => {
      const { handlers, calls } = governedRegistry();

      const result = (await handlers.get(tool)!(args)) as { isError?: boolean };

      expect(result.isError).not.toBe(true);
      const rpc = toolsCalls(calls);
      expect(rpc).toHaveLength(1);
      expect(rpc[0]!.name).toBe(skill);
      expect(rpc[0]!.arguments).toEqual(expected);
      // Every key that arrives is one the contract declares — the same property
      // `governed-binding-contract.test.ts` checks from the advertised shape,
      // asserted here on a concrete call.
      for (const key of Object.keys(rpc[0]!.arguments)) {
        expect(canonical[skill]!.properties, `${skill} declares ${key}`).toContain(key);
      }
      expect(calls.filter((c) => REST_MUTATIONS.has(c.method))).toEqual([]);
    });

    it(`${tool} → ${skill}: an unknown argument is forwarded for the harness to refuse, not dropped`, async () => {
      // The harness answers the way a strict schema does: `denied` / `VALIDATION`.
      const { handlers, calls } = governedRegistry({
        status: 'denied',
        code: 'VALIDATION',
        message: `Input validation error for "${skill}": (root): Unrecognized key: "bogusField"`,
      });

      const result = (await handlers.get(tool)!({ ...args, bogus_field: 'x' })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };

      const rpc = toolsCalls(calls);
      expect(rpc).toHaveLength(1);
      // Forwarded under its camelCase name — `toSkillArgs` has no allow-list, so
      // nothing is silently dropped on this side…
      expect(rpc[0]!.arguments['bogusField']).toBe('x');
      // …and the contract does not declare it, which is what makes the strict
      // schema refuse it (proven against the live Zod on the CMS side).
      expect(canonical[skill]!.properties).not.toContain('bogusField');
      // The refusal surfaces as an error, never as "executed".
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('[VALIDATION]');
      expect(calls.filter((c) => REST_MUTATIONS.has(c.method))).toEqual([]);
    });
  }

  it('a dangerous governed tool surfaces the parked approval instead of claiming success', async () => {
    // All six skills are control-plane in the harness (dangerous flag, a mutating
    // `schema:*` capability, or the `delete` prefix), so the default outcome
    // below autopilot is a parked approval. The stdio result must say so.
    const { handlers, calls } = governedRegistry({
      status: 'pending_approval',
      approvalId: 'apr_7',
      approvalSpace: 'agent',
      agentApprovalId: 'apr_7',
      runId: 'run_7',
    });

    const result = (await handlers.get('create_webhook')!(CASES[3]!.args)) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };

    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('pending approval');
    expect(result.content[0]!.text).toContain('apr_7');
    expect(calls.filter((c) => REST_MUTATIONS.has(c.method))).toEqual([]);
  });
});

describe('tools this change measured and did NOT route', () => {
  it('each carries the reason it stays on REST', () => {
    expect(UNGOVERNED_MUTATIONS['create_cdc_subscription']).toMatch(
      /^contract-narrower-than-tool: payload_mode/,
    );
    expect(UNGOVERNED_MUTATIONS['create_flow']).toMatch(/^skill-weaker-than-rest: /);
    expect(UNGOVERNED_MUTATIONS['install_extension']).toMatch(/^skill-weaker-than-rest: /);
    expect(UNGOVERNED_MUTATIONS['update_extension']).toMatch(/^skill-weaker-than-rest: /);
    for (const tool of ['create_cdc_subscription', 'create_flow', 'install_extension', 'update_extension']) {
      expect(GOVERNED_TOOLS[tool], `${tool} is in exactly one table`).toBeUndefined();
    }
  });

  it('`create_cdc_subscription` is narrower for a real reason: the contract has no payload mode', () => {
    // If a later change teaches the handler `payloadMode` and adds it to the
    // contract, this fails and the tool can be moved into GOVERNED_TOOLS.
    expect(canonical['createCdcSubscription']!.properties).not.toContain('payloadMode');
  });

  it('mode `on` refuses them with the declared reason and issues no REST call', async () => {
    const { handlers, calls } = governedRegistry();
    for (const tool of ['create_cdc_subscription', 'create_flow', 'install_extension', 'update_extension']) {
      const before = calls.length;
      const result = (await handlers.get(tool)!({ confirm: true })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]!.text, tool).toContain(`Known gap: ${UNGOVERNED_MUTATIONS[tool]}`);
      expect(calls.slice(before), tool).toEqual([]);
    }
  });

  it('every declared reason uses one of the documented prefixes', () => {
    const prefixes = /^(contract-narrower-than-tool|skill-weaker-than-rest|no-canonical-contract|no-skill)(:|$)/;
    const offenders = Object.entries(UNGOVERNED_MUTATIONS).filter(([, reason]) => !prefixes.test(reason));
    expect(offenders).toEqual([]);
  });
});

describe('stdio SDK layer · what happens to an unknown argument before the dispatcher', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!();
  });

  it('the MCP SDK strips keys the tool does not advertise, before any handler runs [REAL MCP client]', async () => {
    /**
     * Measured, not changed. `McpServer` parses tool input with `z.object(shape)`
     * (strip mode) and hands the handler the parsed value, so over a real
     * transport an unadvertised key never reaches this package's code — for
     * governed and REST tools alike. The forwarding asserted above therefore
     * protects the dispatcher/harness boundary, not the SDK boundary.
     */
    const { client: cms, calls } = governedCms();
    const server = new McpServer({ name: 'lumibase', version: 'test' });
    registerAllTools(server, cms, {
      dispatcher: new GovernedDispatcher(cms, { mode: 'on', warn: () => undefined }),
    });
    const client = new Client({ name: 'canonical-routing', version: 'test' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });

    await client.callTool({
      name: 'update_webhook',
      arguments: { id: 'wh_1', status: 'inactive', bogus_field: 'x' },
    });

    const rpc = toolsCalls(calls);
    expect(rpc).toHaveLength(1);
    expect(rpc[0]!.name).toBe('updateWebhook');
    expect(rpc[0]!.arguments).toEqual({ id: 'wh_1', status: 'inactive' });
  });
});
