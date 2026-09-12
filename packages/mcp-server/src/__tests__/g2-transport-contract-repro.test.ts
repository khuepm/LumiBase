import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';

/**
 * G2 (#454) — reproduction only, npm stdio side. NO implementation change.
 *
 * Companion to `apps/cms/src/services/__tests__/g2-mcp-contract-repro.test.ts`.
 * These assertions describe the CURRENT stdio contract so that a later fix
 * flips them deliberately. The gap under test is the issue's first acceptance
 * bullet: "one authoritative contract, not independently drifting registries".
 */

interface CapturedTool {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function fakeServer() {
  const tools = new Map<string, CapturedTool>();
  const server = {
    registerTool(name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) {
      if (tools.has(name)) throw new Error(`Duplicate tool name: ${name}`);
      tools.set(name, { config, handler });
    },
  };
  return { server, tools };
}

function fakeClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
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
    getText: vi.fn((path: string) => {
      calls.push({ method: 'GET_TEXT', path });
      return Promise.resolve('ndjson');
    }),
    getRootText: vi.fn((path: string) => {
      calls.push({ method: 'GET_ROOT', path });
      return Promise.resolve('ok');
    }),
    postRaw: vi.fn((path: string, body: unknown) => {
      calls.push({ method: 'POST_RAW', path, body });
      return Promise.resolve({ ok: true });
    }),
  };
  return { client: client as unknown as LumiBaseClient, calls };
}

function build() {
  const { server, tools } = fakeServer();
  const { client, calls } = fakeClient();
  registerAllTools(server as never, client);
  return { tools, calls };
}

describe('G2 repro · stdio transport never reaches the governed harness', () => {
  it('S1: no stdio tool routes through /mcp or /agent/skills — every call is a plain REST write', async () => {
    const { tools, calls } = build();

    // One content write, one schema write, one schema delete, one read.
    await tools.get('create_item')!.handler({ collection: 'posts', data: { title: 'x' }, status: 'draft' });
    await tools.get('create_collection')!.handler({ name: 'posts' });
    await tools.get('delete_collection')!.handler({ name: 'posts', confirm: true });
    await tools.get('list_items')!.handler({ collection: 'posts' });

    const paths = calls.map((c) => `${c.method} ${c.path}`);

    // CURRENT: writes land on the ordinary REST surface. The harness — kill
    // switch, capability gate, autonomy level, HITL approval, veto window,
    // agent_runs / agent_tool_calls audit — is never entered.
    // EXPECTED: a governed tool call is governed on BOTH transports.
    expect(paths).toContain('POST /items/posts');
    expect(paths).toContain('POST /collections');
    expect(paths).toContain('DELETE /collections/posts');
    expect(paths).toContain('GET /items/posts');
    expect(paths.some((p) => p.includes('/mcp'))).toBe(false);
    expect(paths.some((p) => p.includes('/agent/skills'))).toBe(false);
  });

  it('S2: a dangerous stdio call returns no approval id — it cannot park for HITL', async () => {
    const { tools, calls } = build();

    // `delete_collection` is the stdio counterpart of the HTTP MCP
    // `deleteCollection` skill, which is control-plane + dangerous: it parks a
    // pending approval (CMS-side repro R5) and additionally requires an admin
    // principal via the `mcp.ts` backstop. Neither applies on this transport.
    const result = (await tools.get('delete_collection')!.handler({
      name: 'posts',
      confirm: true,
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    // CURRENT: the delete is issued immediately and the result carries no
    // approvalId / pending status — `confirm: true` is a client-side prompt,
    // not a governance gate. RBAC is still enforced by the REST route
    // (`requireSchemaPermission('schema:delete')`), so this is a missing
    // AGENT-governance gate, not a missing permission check.
    // EXPECTED: the same skill parks identically on both transports.
    expect(calls.map((c) => c.method)).toContain('DELETE');
    expect(JSON.stringify(result)).not.toMatch(/approvalId|pending_approval/);
  });

  it('S3: stdio validates inputs with Zod while HTTP MCP advertises no schema at all', () => {
    const { tools } = build();

    // CURRENT: the two transports are inconsistent in BOTH directions — stdio
    // has real per-field schemas that HTTP MCP lacks, and HTTP MCP has harness
    // governance that stdio lacks.
    const createItem = tools.get('create_item')!;
    expect(Object.keys(createItem.config.inputSchema ?? {}).sort()).toEqual([
      'collection',
      'data',
      'status',
    ]);

    const deleteItem = tools.get('delete_item')!;
    expect(Object.keys(deleteItem.config.inputSchema ?? {}).sort()).toEqual([
      'collection',
      'confirm',
      'id',
    ]);
  });

  it('S4: stdio tool names are snake_case REST verbs, disjoint from the camelCase skill registry', () => {
    const { tools } = build();
    const names = [...tools.keys()];

    // Camel-case harness skill names (the HTTP MCP surface) appear nowhere here.
    for (const skillName of ['createItem', 'deleteItem', 'createCollection', 'deleteCollection', 'listItems']) {
      expect(names, `${skillName} is absent from the stdio surface`).not.toContain(skillName);
    }
    expect(names).toContain('create_item');
    expect(names).toContain('delete_collection');
  });
});
