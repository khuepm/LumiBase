import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { adminRbac, memberRbac, selectForRbac, type FakePrincipalRbac } from '../../test-utils/rbac-principal-db';

/**
 * #346 — OAuth scopes on the MCP endpoint only ever NARROW the RBAC grant, and
 * the CONTROL_PLANE_FORBIDDEN backstop keeps working unchanged for OAuth
 * principals (it runs first; scope checks can only take more away).
 */

vi.mock('../../services/feature-flags', () => ({
  getContentOsFlags: vi.fn().mockResolvedValue({ mcp: true, vetoWindow: false }),
}));

const harnessExecute = vi.fn();
vi.mock('../../services/ai-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ai-harness')>();
  return { ...actual, AISecureHarness: class { execute = harnessExecute; } };
});

const { mcpRouter } = await import('../mcp');

const RESOURCE = 'https://cms.acme.com/api/v1/mcp';

function oauthUser(userId: string, scopes: string[]): AuthPrincipal {
  return {
    type: 'user',
    userId,
    email: `${userId}@example.com`,
    roles: ['role_x'],
    raw: { iss: 'https://auth.acme.com', aud: RESOURCE },
    oauth: { issuer: 'https://auth.acme.com', resource: RESOURCE, scopes },
  };
}

async function call(auth: AuthPrincipal, rbac: FakePrincipalRbac, method: string, params?: Record<string, unknown>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    c.set('siteId', 'site_1');
    c.set('requestId', 'req_1');
    c.set('db', { insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }), select: selectForRbac(rbac) } as never);
    c.set('runtime', { cache: undefined, search: {}, queue: undefined } as never);
    c.env = { LUMIBASE_PUBLIC_URL: 'https://cms.acme.com' } as never;
    await next();
  });
  app.route('/api/v1/mcp', mcpRouter);
  const res = await app.request('/api/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}

const READ_WRITE = [{ collection: 'posts', action: 'read' }, { collection: 'posts', action: 'update' }];

describe('MCP OAuth scope narrowing', () => {
  beforeEach(() => {
    harnessExecute.mockReset();
    harnessExecute.mockResolvedValue({ status: 'executed', data: { ok: true } });
  });

  it('passes only the scoped subset of the RBAC grant to the harness', async () => {
    const { status } = await call(oauthUser('u1', ['mcp:read']), memberRbac('u1', READ_WRITE), 'tools/call', {
      name: 'listItems',
      arguments: { collection: 'posts' },
    });
    expect(status).toBe(200);
    expect(harnessExecute.mock.calls[0]?.[2]).toEqual(['items:read']);
  });

  it('answers 403 insufficient_scope (step-up) when the grant has it but the scope removed it', async () => {
    const { status, headers, body } = await call(oauthUser('u1', ['mcp:read']), memberRbac('u1', READ_WRITE), 'tools/call', {
      name: 'createItem',
      arguments: { collection: 'posts', data: {} },
    });
    expect(status).toBe(403);
    expect((body.errors as Array<{ code: string }>)[0]?.code).toBe('INSUFFICIENT_SCOPE');
    expect(headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="mcp:write", resource_metadata="https://cms.acme.com/.well-known/oauth-protected-resource/api/v1/mcp"',
    );
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it('does not widen: scopes beyond the grant still leave the harness to deny', async () => {
    const { status } = await call(oauthUser('u1', ['mcp:read', 'mcp:write']), memberRbac('u1'), 'tools/call', {
      name: 'createItem',
      arguments: { collection: 'posts', data: {} },
    });
    expect(status).toBe(200);
    expect(harnessExecute.mock.calls[0]?.[2]).toEqual([]);
  });

  it('keeps CONTROL_PLANE_FORBIDDEN for a non-admin OAuth principal, even with mcp:admin', async () => {
    const { status, body } = await call(
      oauthUser('u1', ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin']),
      memberRbac('u1', READ_WRITE),
      'tools/call',
      { name: 'deleteCollection', arguments: { name: 'posts' } },
    );
    expect(status).toBe(403);
    expect((body.errors as Array<{ code: string }>)[0]?.code).toBe('CONTROL_PLANE_FORBIDDEN');
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it('requires mcp:admin for a control-plane skill even from an admin', async () => {
    const { status, headers } = await call(oauthUser('u2', ['mcp:read', 'mcp:write', 'mcp:delete']), adminRbac('u2'), 'tools/call', {
      name: 'deleteCollection',
      arguments: { name: 'posts' },
    });
    expect(status).toBe(403);
    expect(headers.get('www-authenticate')).toContain('scope="mcp:admin"');
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it('an admin with all four scopes keeps the admin grant', async () => {
    const { status } = await call(oauthUser('u2', ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin']), adminRbac('u2'), 'tools/call', {
      name: 'deleteCollection',
      arguments: { name: 'posts' },
    });
    expect(status).toBe(200);
    expect(harnessExecute.mock.calls[0]?.[2]).toEqual(['admin']);
  });

  it('an admin with read-only scope gets an expanded, read-only capability set', async () => {
    const { status } = await call(oauthUser('u2', ['mcp:read']), adminRbac('u2'), 'tools/call', {
      name: 'listItems',
      arguments: { collection: 'posts' },
    });
    expect(status).toBe(200);
    const caps = harnessExecute.mock.calls[0]?.[2] as string[];
    expect(caps).toContain('items:read');
    expect(caps).not.toContain('admin');
    expect(caps.every((cap) => cap.endsWith(':read'))).toBe(true);
  });

  it('refuses the organization plane to OAuth principals', async () => {
    const { status, body } = await call(oauthUser('u2', ['mcp:read']), adminRbac('u2'), 'tools/call', {
      name: 'org:list_sites',
      arguments: { organizationId: 'org_1' },
    });
    expect(status).toBe(403);
    expect((body.errors as Array<{ code: string }>)[0]?.code).toBe('ORGANIZATION_FORBIDDEN');
  });

  it('discovery stays open with no recognised scope', async () => {
    const { status } = await call(oauthUser('u1', []), memberRbac('u1'), 'initialize', { protocolVersion: '2025-06-18' });
    expect(status).toBe(200);
  });
});
