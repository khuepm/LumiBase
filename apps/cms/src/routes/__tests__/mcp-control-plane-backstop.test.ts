import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { CORE_SKILLS, isControlPlaneSkill } from '../../services/ai-harness';

/**
 * Defense-in-depth admin backstop on the MCP endpoint.
 *
 * Context: the MCP surface (`POST /api/v1/mcp`) is intentionally NOT listed in
 * `CONTROL_PLANE_PATHS`, so `withControlPlaneAccessGuard()` never runs for it —
 * exactly like `/api/v1/agent/*`. Both rely on the harness's in-code capability
 * + HITL checks, which the `mcp-parity.property.test.ts` proves are identical
 * across the two surfaces. A low-privileged token therefore could never invoke
 * a control-plane skill via MCP in the first place (its `auth.roles` carry role
 * ids, never the granular `schema:*` / `access:*` capability strings the
 * harness requires).
 *
 * This test covers the EXTRA backstop added on top of that: a `tools/call`
 * targeting a control-plane skill (dangerous / schema-mutating / `delete*`)
 * is rejected with 403 `CONTROL_PLANE_FORBIDDEN` BEFORE the harness runs unless
 * the caller is an admin principal — mirroring the control-plane guard's "stay
 * behind an admin even if the in-code check is later weakened" intent. Safe
 * reads and the discovery methods (`tools/list`, `initialize`, `ping`) stay
 * open to non-admins, preserving Agent-API parity for everything else.
 */

// Force the per-site MCP flag on so the route reaches the backstop. The flag
// gate (`flags.mcp`) is orthogonal to this guard and covered elsewhere.
vi.mock('../../services/feature-flags', () => ({
  getContentOsFlags: vi.fn().mockResolvedValue({ mcp: true, vetoWindow: false }),
}));

// The backstop denies BEFORE `McpService.handle` runs the harness, so the
// harness never touches the DB on the denial paths. We still spy on it to
// assert the guard short-circuits (harness not constructed-and-run) on deny.
const harnessExecute = vi.fn();
vi.mock('../../services/ai-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ai-harness')>();
  return {
    ...actual,
    AISecureHarness: class {
      execute = harnessExecute;
    },
  };
});

// Imported after the mocks above are registered.
const { mcpRouter } = await import('../mcp');

function rpc(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
}

function buildApp(auth: AuthPrincipal): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const insertValues = vi.fn().mockResolvedValue(undefined);
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    c.set('siteId', 'site_1');
    c.set('requestId', 'req_1');
    // DB is only touched by the audit logger on a denial; a fluent insert stub
    // is enough. The backstop never queries on the allow paths.
    c.set('db', { insert: () => ({ values: insertValues }) } as never);
    c.set('runtime', {
      cache: {} as never,
      search: {} as never,
      queue: undefined,
    } as never);
    c.env = {} as never;
    await next();
  });
  app.route('/api/v1/mcp', mcpRouter);
  return app;
}

const MEMBER: AuthPrincipal = { userId: 'u1', email: 'member@example.com', roles: ['member'], raw: {} };
const ADMIN: AuthPrincipal = { userId: 'u2', email: 'admin@example.com', roles: ['admin'], raw: {} };
const API_KEY: AuthPrincipal = { type: 'api_key', apiKeyId: 'k1', roles: [], raw: {} } as AuthPrincipal;

async function call(auth: AuthPrincipal, method: string, params?: Record<string, unknown>) {
  const res = await buildApp(auth).request('/api/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rpc(method, params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('MCP control-plane admin backstop', () => {
  beforeEach(() => {
    harnessExecute.mockReset();
    harnessExecute.mockResolvedValue({ status: 'executed', data: { ok: true } });
  });

  it('denies a non-admin tools/call for a control-plane skill with 403 before the harness runs', async () => {
    const { status, body } = await call(MEMBER, 'tools/call', { name: 'deleteCollection', arguments: { name: 'posts' } });
    expect(status).toBe(403);
    expect((body.errors as Array<{ code: string }>)[0]?.code).toBe('CONTROL_PLANE_FORBIDDEN');
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it('denies an API-key principal (empty roles) the same way', async () => {
    const { status, body } = await call(API_KEY, 'tools/call', { name: 'createRole', arguments: { name: 'editor' } });
    expect(status).toBe(403);
    expect((body.errors as Array<{ code: string }>)[0]?.code).toBe('CONTROL_PLANE_FORBIDDEN');
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it('lets an admin tools/call for a control-plane skill through to the harness', async () => {
    const { status } = await call(ADMIN, 'tools/call', { name: 'deleteCollection', arguments: { name: 'posts' } });
    expect(status).toBe(200);
    expect(harnessExecute).toHaveBeenCalledWith('deleteCollection', { name: 'posts' }, ['admin'], undefined);
  });

  it('lets a non-admin tools/call for a SAFE read skill through (parity preserved)', async () => {
    const { status } = await call(MEMBER, 'tools/call', { name: 'listCollections', arguments: {} });
    expect(status).toBe(200);
    expect(harnessExecute).toHaveBeenCalledWith('listCollections', {}, ['member'], undefined);
  });

  it('lets non-admin discovery methods through unguarded (tools/list, initialize, ping)', async () => {
    // initialize + ping return results; tools/list reaches the registry. None
    // are gated. `initialize` is the cheapest to assert without a registry.
    const { status, body } = await call(MEMBER, 'initialize', { protocolVersion: '2025-06-18' });
    expect(status).toBe(200);
    expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('lumibase-mcp');
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it('audits the denial as mcp_control_plane_skill_denied', async () => {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    app.use('*', async (c, next) => {
      c.set('auth', MEMBER);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
      c.set('db', { insert: () => ({ values }) } as never);
      c.set('runtime', { cache: {}, search: {}, queue: undefined } as never);
      c.env = {} as never;
      await next();
    });
    app.route('/api/v1/mcp', mcpRouter);

    const res = await app.request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpc('tools/call', { name: 'upsertSetting', arguments: { key: 'x', value: {} } }),
    });
    expect(res.status).toBe(403);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_control_plane_skill_denied',
        actorEmail: 'member@example.com',
        siteId: 'site_1',
        metadata: expect.objectContaining({ reason: 'non_admin_control_plane_skill', skill: 'upsertSetting' }),
      }),
    );
  });
});

describe('control-plane skill classifier (isControlPlaneSkill)', () => {
  it('flags every dangerous, schema-mutating, or delete* CORE skill', () => {
    // Lock the classifier against the real registry so a newly added governed
    // skill that should be gated cannot silently slip through the backstop.
    const flagged = Object.entries(CORE_SKILLS)
      .filter(([name, skill]) => isControlPlaneSkill(skill, name))
      .map(([name]) => name)
      .sort();

    // Spot-check representative members of each rule.
    expect(flagged).toContain('deleteCollection'); // delete* + schema:delete
    expect(flagged).toContain('createField'); // schema:update (mutating schema:*)
    expect(flagged).toContain('createRole'); // dangerous: true (access:create)
    expect(flagged).toContain('upsertSetting'); // dangerous: true (config:write)
    expect(flagged).toContain('revokeApiKey'); // dangerous: true + api-keys:delete
    expect(flagged).toContain('runFlow'); // dangerous: true (flows:run)

    // Safe reads must NOT be flagged — they stay open to non-admins.
    expect(flagged).not.toContain('listCollections');
    expect(flagged).not.toContain('listItems');
    expect(flagged).not.toContain('listRoles');
    expect(flagged).not.toContain('aiSuggestField'); // schema:read only
  });

  it('treats item CRUD as non-control-plane (autonomy behaviour unchanged)', () => {
    // Item writes are deliberately NOT control-plane: they keep their existing
    // autonomy/HITL behaviour and are not admin-gated at the MCP boundary.
    expect(isControlPlaneSkill(CORE_SKILLS['createItem']!, 'createItem')).toBe(false);
    expect(isControlPlaneSkill(CORE_SKILLS['updateItem']!, 'updateItem')).toBe(false);
    // `deleteItem` is gated purely by the `delete*` name rule.
    expect(isControlPlaneSkill(CORE_SKILLS['deleteItem']!, 'deleteItem')).toBe(true);
  });
});
