import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';
import { registerPromptForwarding } from '../tools/prompts.js';

/** stdio prompt forwarding (#712, B200). The CMS decides who sees what; this only forwards. */

function fakeServer() {
  const prompts = new Map<string, { config: Record<string, unknown>; cb: () => Promise<unknown> }>();
  const server = {
    registerPrompt(name: string, config: Record<string, unknown>, cb: () => Promise<unknown>) {
      prompts.set(name, { config, cb });
    },
  };
  return { server: server as unknown as McpServer, prompts };
}

const LISTED = {
  prompts: [
    { name: 'house-style', title: 'House style', description: 'Voice and tone' },
    { name: 'ext:notes:note-style' },
    { title: 'no name' },
  ],
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  const jsonRpc = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'prompts/list') return LISTED;
    return { messages: [{ role: 'user', content: { type: 'text', text: `body of ${String(params?.['name'])}` } }] };
  });
  return { client: { tokenKind: 'site', siteId: undefined, jsonRpc, ...overrides } as unknown as LumiBaseClient, jsonRpc };
}

describe('stdio prompt forwarding (#712, B200)', () => {
  it('registers every prompt the governed endpoint lists and forwards prompts/get', async () => {
    const { server, prompts } = fakeServer();
    const { client, jsonRpc } = fakeClient();
    expect(await registerPromptForwarding(server, client)).toBe(2);
    expect([...prompts.keys()]).toEqual(['house-style', 'ext:notes:note-style']);
    expect(prompts.get('house-style')!.config).toEqual({ title: 'House style', description: 'Voice and tone' });
    const result = (await prompts.get('house-style')!.cb()) as { messages: Array<{ content: { text: string } }> };
    expect(jsonRpc).toHaveBeenLastCalledWith('prompts/get', { name: 'house-style' });
    expect(result.messages[0]!.content.text).toBe('body of house-style');
  });

  it('a prompt the server no longer offers surfaces the server error', async () => {
    const { server, prompts } = fakeServer();
    const { client, jsonRpc } = fakeClient();
    await registerPromptForwarding(server, client);
    jsonRpc.mockRejectedValueOnce(new Error('JSONRPC_-32602: Unknown prompt: house-style'));
    await expect(prompts.get('house-style')!.cb()).rejects.toThrow('Unknown prompt');
  });

  it('offers nothing when the endpoint is unavailable or for an unpinned organization token', async () => {
    const unpinned = fakeClient({ tokenKind: 'organization' });
    const a = fakeServer();
    expect(await registerPromptForwarding(a.server, unpinned.client)).toBe(0);
    expect(unpinned.jsonRpc).not.toHaveBeenCalled();
    const off = fakeClient();
    off.jsonRpc.mockRejectedValueOnce(new Error('MCP disabled'));
    const b = fakeServer();
    expect(await registerPromptForwarding(b.server, off.client)).toBe(0);
    expect(b.prompts.size).toBe(0);
  });
});

describe('stdio prompt forwarding over the real MCP protocol', () => {
  it('an MCP client lists and gets a forwarded prompt', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const { client: cms } = fakeClient();
    await registerPromptForwarding(server, cms);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name)).toEqual(['house-style', 'ext:notes:note-style']);
    const got = await client.getPrompt({ name: 'ext:notes:note-style' });
    expect(got.messages[0]!.content).toEqual({ type: 'text', text: 'body of ext:notes:note-style' });
    await client.close();
  });
});
