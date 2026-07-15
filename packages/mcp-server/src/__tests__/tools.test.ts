import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';
import {
  encodeMediaKey,
  encodePathSegment,
  idPathSegmentSchema,
  mediaKeySchema,
} from '../tools/path.js';

interface CapturedTool {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Minimal stand-in for McpServer that records registered tools. */
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

/** Records the method+path+body of every client call. */
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

const DESTRUCTIVE = /^(delete_|remove_|detach_|revoke_|uninstall_|drop_)/;
const DESTRUCTIVE_EXTRA = new Set(['restore_backup', 'rotate_api_key', 'apply_access_import']);

describe('registerAllTools', () => {
  const { server, tools } = fakeServer();
  const { client } = fakeClient();
  registerAllTools(server as never, client);

  it('registers a broad set of uniquely-named tools', () => {
    expect(tools.size).toBeGreaterThan(60);
  });

  it('exposes representative tools across every domain', () => {
    for (const name of [
      'list_collections',
      'list_roles',
      'create_role',
      'delete_role',
      'list_policies',
      'create_api_key',
      'invite_user',
      'create_team',
      'run_flow',
      'create_intent',
      'list_relations',
      'upsert_setting',
      'search',
      'list_media',
      'list_activity',
      'export_backup',
      'list_extensions',
      'lookup_tm',
      'get_my_permissions',
      'list_dashboards',
      'run_panel',
      'query_insights',
    ]) {
      expect(tools.has(name), `missing tool: ${name}`).toBe(true);
    }
  });

  it('requires confirm=true on every destructive tool', () => {
    for (const [name, tool] of tools) {
      const isDestructive = DESTRUCTIVE.test(name) || DESTRUCTIVE_EXTRA.has(name);
      if (!isDestructive) continue;
      const confirm = tool.config.inputSchema?.['confirm'];
      expect(confirm, `${name} should have a confirm field`).toBeDefined();
      expect(confirm!.safeParse(true).success, `${name} confirm should accept true`).toBe(true);
      expect(confirm!.safeParse(false).success, `${name} confirm should reject false`).toBe(false);
    }
  });
});

describe('tool handlers call the right endpoints', () => {
  it('list_roles → GET /roles', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('list_roles')!.handler({});
    expect(calls).toContainEqual({ method: 'GET', path: '/roles', body: undefined });
  });

  it('delete_role → DELETE /roles/:id and confirms', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    const result = (await tools.get('delete_role')!.handler({ id: 'r1', confirm: true })) as {
      content: Array<{ text: string }>;
    };
    expect(calls).toContainEqual({ method: 'DELETE', path: '/roles/r1', body: undefined });
    expect(result.content[0]!.text).toContain('deleted');
  });

  it('create_item → POST /items/:collection', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('create_item')!.handler({ collection: 'posts', data: { title: 'x' } });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/items/posts')).toBe(true);
  });

  it('export_backup → GET text /admin/backup', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('export_backup')!.handler({});
    expect(calls).toContainEqual({ method: 'GET_TEXT', path: '/admin/backup' });
  });

  it('list_dashboards → GET /dashboards', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('list_dashboards')!.handler({});
    expect(calls).toContainEqual({ method: 'GET', path: '/dashboards', body: undefined });
  });

  it('run_panel → POST /dashboards/:id/panels/:panelId/data with override body', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('run_panel')!.handler({
      dashboardId: 'd1',
      panelId: 'p1',
      filter: { status: { _eq: 'published' } },
    });
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/dashboards/d1/panels/p1/data',
      body: { filter: { status: { _eq: 'published' } } },
    });
  });

  it('query_insights → POST /dashboards/:id/panels/preview with query body only', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('query_insights')!.handler({
      dashboardId: 'd1',
      collection: 'posts',
      aggregate: 'count',
    });
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/dashboards/d1/panels/preview',
      body: { collection: 'posts', aggregate: 'count' },
    });
  });
});

describe('path-parameter hardening', () => {
  describe('idPathSegmentSchema', () => {
    it('accepts opaque ids', () => {
      for (const id of ['r1', 'nano_id-123', '0191f2e8-7b3a-7c1d-9f0e-abcdef012345']) {
        expect(idPathSegmentSchema.safeParse(id).success, id).toBe(true);
      }
    });

    it('rejects traversal and path separators', () => {
      for (const bad of ['.', '..', '../roles', 'a/b', 'a\\b', '']) {
        expect(idPathSegmentSchema.safeParse(bad).success, bad).toBe(false);
      }
    });
  });

  describe('mediaKeySchema', () => {
    it('accepts multi-segment storage keys', () => {
      for (const key of ['asset.txt', 'folder/sub/file.png']) {
        expect(mediaKeySchema.safeParse(key).success, key).toBe(true);
      }
    });

    it('rejects traversal, absolute, and backslash keys', () => {
      for (const bad of ['../secret', 'a/../b', '/abs/path', 'a\\b', '']) {
        expect(mediaKeySchema.safeParse(bad).success, bad).toBe(false);
      }
    });
  });

  it('encodePathSegment percent-encodes the whole segment', () => {
    expect(encodePathSegment('a b')).toBe('a%20b');
    expect(encodePathSegment('a/b')).toBe('a%2Fb');
  });

  it('encodeMediaKey encodes each segment but preserves separators', () => {
    expect(encodeMediaKey('folder/a b.png')).toBe('folder/a%20b.png');
  });

  it('id path segments are encoded before reaching the client', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('delete_role')!.handler({ id: 'a b', confirm: true });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/roles/a%20b', body: undefined });
  });

  it('media keys are encoded per segment before reaching the client', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('delete_media')!.handler({ key: 'folder/a b.png', confirm: true });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/media/folder/a%20b.png', body: undefined });
  });

  it('setting keys allow dots but reject traversal', () => {
    const { server, tools } = fakeServer();
    const { client } = fakeClient();
    registerAllTools(server as never, client);
    const keySchema = tools.get('get_setting')!.config.inputSchema!['key']!;
    expect(keySchema.safeParse('contentOs.mcp').success).toBe(true);
    expect(keySchema.safeParse('..').success).toBe(false);
    expect(keySchema.safeParse('a/b').success).toBe(false);
  });
});
