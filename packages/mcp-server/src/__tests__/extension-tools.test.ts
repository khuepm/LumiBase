import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';
import { registerExtensionTools, zodShapeFromJsonSchema } from '../tools/extension-tools.js';

interface Captured {
  config: { description?: string; inputSchema?: Record<string, z.ZodType> };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function fakeServer() {
  const tools = new Map<string, Captured>();
  const server = {
    registerTool(name: string, config: Captured['config'], handler: Captured['handler']) {
      tools.set(name, { config, handler });
    },
  };
  return { server: server as unknown as McpServer, tools };
}

const LISTED = {
  tools: [
    { name: 'listItems', description: 'core', inputSchema: { type: 'object' } },
    {
      name: 'ext_notes__appendNote',
      description: 'Append a note (extension: notes)',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Body' }, pinned: { type: 'boolean' } },
        required: ['text'],
      },
    },
  ],
};

function fakeClient(overrides: Partial<Record<'readOnly' | 'tokenKind' | 'siteId', unknown>> = {}, callResult?: unknown) {
  const jsonRpc = vi.fn(async (method: string) => {
    if (method === 'tools/list') return LISTED;
    return callResult;
  });
  return { client: { readOnly: false, tokenKind: 'site', siteId: undefined, jsonRpc, ...overrides } as unknown as LumiBaseClient, jsonRpc };
}

describe('stdio extension tools (#715)', () => {
  it('registers only ext_* tools from the governed tools/list', async () => {
    const { server, tools } = fakeServer();
    const { client } = fakeClient();
    expect(await registerExtensionTools(server, client)).toBe(1);
    expect([...tools.keys()]).toEqual(['ext_notes__appendNote']);
    const shape = tools.get('ext_notes__appendNote')!.config.inputSchema!;
    expect(shape['text']!.safeParse('hi').success).toBe(true);
    expect(shape['text']!.safeParse(undefined).success).toBe(false);
    expect(shape['pinned']!.safeParse(undefined).success).toBe(true);
  });

  it('forwards every call to the governed endpoint and renders the decision', async () => {
    const { server, tools } = fakeServer();
    const { client, jsonRpc } = fakeClient({}, {
      structuredContent: { status: 'pending_approval', approvalId: 'apr_1', approvalSpace: 'agent', agentApprovalId: 'apr_1' },
    });
    await registerExtensionTools(server, client);
    const result = await tools.get('ext_notes__appendNote')!.handler({ text: 'x' });
    expect(jsonRpc).toHaveBeenLastCalledWith('tools/call', { name: 'ext_notes__appendNote', arguments: { text: 'x' } });
    expect(result.content[0]!.text).toContain('pending approval');
    expect(result.content[0]!.text).toContain('apr_1');
  });

  it('reports a transport failure as an error result, never a REST fallback', async () => {
    const { server, tools } = fakeServer();
    const { client, jsonRpc } = fakeClient();
    await registerExtensionTools(server, client);
    jsonRpc.mockRejectedValueOnce(new Error('boom'));
    const result = await tools.get('ext_notes__appendNote')!.handler({ text: 'x' });
    expect(result.isError).toBe(true);
  });

  it('offers nothing in read-only mode, to an unpinned org token, or when the endpoint is unavailable', async () => {
    for (const overrides of [{ readOnly: true }, { tokenKind: 'organization' }]) {
      const { server, tools } = fakeServer();
      const { client, jsonRpc } = fakeClient(overrides);
      expect(await registerExtensionTools(server, client)).toBe(0);
      expect(tools.size).toBe(0);
      expect(jsonRpc).not.toHaveBeenCalled();
    }
    const { server, tools } = fakeServer();
    const { client, jsonRpc } = fakeClient();
    jsonRpc.mockRejectedValueOnce(new Error('MCP disabled'));
    expect(await registerExtensionTools(server, client)).toBe(0);
    expect(tools.size).toBe(0);
  });

  it('maps JSON Schema types onto a zod shape', () => {
    const shape = zodShapeFromJsonSchema({
      type: 'object',
      properties: { n: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array' }, any: {} },
      required: ['n', 'mode'],
    });
    expect(shape['n']!.safeParse(1.5).success).toBe(false);
    expect(shape['mode']!.safeParse('c').success).toBe(false);
    expect(shape['tags']!.safeParse(['x']).success).toBe(true);
    expect(shape['any']!.safeParse({ deep: 1 }).success).toBe(true);
    expect(zodShapeFromJsonSchema(undefined)).toEqual({});
  });
});
