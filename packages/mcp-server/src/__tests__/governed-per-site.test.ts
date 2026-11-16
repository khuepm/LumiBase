import { describe, expect, it, vi } from 'vitest';
import { LumiBaseClient, McpUnavailableError } from '../client.js';
import { GovernedDispatcher } from '../governed.js';

describe('governed probe isolation', () => {
  it("does not reuse an unavailable site's probe for a different site", async () => {
    const client = new LumiBaseClient({ url: 'https://example.test', token: 'lbo_test' });
    const calls: string[] = [];
    vi.spyOn(client, 'jsonRpc').mockImplementation(async (method) => {
      calls.push(`${client.currentSiteId}:${method}`);
      if (client.currentSiteId === 'disabled' && method === 'tools/list') throw new McpUnavailableError('disabled');
      return { structuredContent: { status: 'executed' } } as never;
    });
    const dispatcher = new GovernedDispatcher(client, { mode: 'auto', warn: () => {} });
    const binding = { skill: 'listItems' };
    expect(await client.withSite('disabled', () => dispatcher.dispatch('list_items', {}, binding))).toBeUndefined();
    expect(await client.withSite('enabled', () => dispatcher.dispatch('list_items', {}, binding))).toBeDefined();
    expect(calls).toContain('enabled:tools/list');
    expect(calls).toContain('enabled:tools/call');
  });
});
