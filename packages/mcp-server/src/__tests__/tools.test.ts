import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';
import {
  collectionNameSchema,
  encodePath,
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
});

describe('path parameter hardening', () => {
  describe('idPathSegmentSchema', () => {
    it('accepts ordinary ids', () => {
      for (const ok of ['r1', 'nano_id-123', 'a.b', 'AbC']) {
        expect(idPathSegmentSchema.safeParse(ok).success, ok).toBe(true);
      }
    });

    it('rejects traversal and path separators', () => {
      for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../etc']) {
        expect(idPathSegmentSchema.safeParse(bad).success, bad).toBe(false);
      }
    });
  });

  describe('collectionNameSchema', () => {
    it('accepts lowercase snake_case', () => {
      expect(collectionNameSchema.safeParse('blog_posts').success).toBe(true);
    });

    it('rejects names with separators, uppercase, or leading digit', () => {
      for (const bad of ['Posts', 'a/b', '1posts', 'po sts', '../x']) {
        expect(collectionNameSchema.safeParse(bad).success, bad).toBe(false);
      }
    });
  });

  describe('mediaKeySchema / encodePath', () => {
    it('allows nested keys but rejects traversal and leading slash', () => {
      expect(mediaKeySchema.safeParse('posts/2024/img.png').success).toBe(true);
      expect(mediaKeySchema.safeParse('../secret').success).toBe(false);
      expect(mediaKeySchema.safeParse('/abs').success).toBe(false);
    });

    it('encodePath preserves separators but encodes segments', () => {
      expect(encodePath('posts/my file.png')).toBe('posts/my%20file.png');
    });
  });

  it('encodePathSegment percent-encodes a whole segment', () => {
    expect(encodePathSegment('a b/c')).toBe('a%20b%2Fc');
  });

  it('get_item encodes path segments before calling the API', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    // The handler trusts the framework for schema validation; a value that
    // slips through with a space must still be percent-encoded in the path.
    await tools.get('get_item')!.handler({ collection: 'posts', id: 'id with space' });
    expect(calls.some((c) => c.path === '/items/posts/id%20with%20space')).toBe(true);
  });

  it('delete_media keeps nested key slashes but encodes segments', async () => {
    const { server, tools } = fakeServer();
    const { client, calls } = fakeClient();
    registerAllTools(server as never, client);
    await tools.get('delete_media')!.handler({ key: 'posts/my file.png', confirm: true });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/media/posts/my%20file.png')).toBe(
      true,
    );
  });
});
