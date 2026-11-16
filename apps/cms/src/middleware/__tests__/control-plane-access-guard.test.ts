import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { hasSiteAdminAccess, isAdminPrincipal, isControlPlanePath, withControlPlaneAccessGuard } from '../control-plane-access-guard';

describe('control-plane access guard helpers', () => {
  it('identifies system administration paths', () => {
    expect(isControlPlanePath('/api/v1/roles')).toBe(true);
    expect(isControlPlanePath('/api/v1/roles/role-1/users')).toBe(true);
    expect(isControlPlanePath('/api/v1/materialize/mat_1/refresh')).toBe(true);
    expect(isControlPlanePath('/api/v1/agent')).toBe(true);
    expect(isControlPlanePath('/api/v1/agent/goals')).toBe(true);
    expect(isControlPlanePath('/api/v1/agent/intents')).toBe(true);
    expect(isControlPlanePath('/api/v1/items/posts')).toBe(false);
  });

  it('recognizes admin principals', () => {
    expect(isAdminPrincipal({ roles: ['admin'], raw: {} })).toBe(true);
    expect(isAdminPrincipal({ roles: ['administrator'], raw: {} })).toBe(true);
    expect(isAdminPrincipal({ roles: ['member'], raw: {} })).toBe(false);
  });
});

describe('control-plane access guard middleware', () => {
  it('audits and fails closed on non-admin access to system routes', async () => {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      c.set('auth', { email: 'member@example.com', roles: ['member'], raw: {} });
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
      await next();
    });
    app.use('*', withControlPlaneAccessGuard());
    app.get('/api/v1/roles', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/roles');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'CONTROL_PLANE_FORBIDDEN' }] });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      event: 'control_plane_access_denied',
      actorEmail: 'member@example.com',
      siteId: 'site_1',
      requestId: 'req_1',
      metadata: expect.objectContaining({ reason: 'non_admin_control_plane_route' }),
    }));
  });

  it('blocks non-admin access to agent harness routes', async () => {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      c.set('auth', { email: 'member@example.com', roles: ['member'], raw: {} });
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_agent');
      await next();
    });
    app.use('*', withControlPlaneAccessGuard());
    app.post('/api/v1/agent/goals', (c) => c.json({ ok: true }, 201));

    const res = await app.request('/api/v1/agent/goals', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'CONTROL_PLANE_FORBIDDEN' }] });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      event: 'control_plane_access_denied',
      metadata: expect.objectContaining({ path: '/api/v1/agent/goals' }),
    }));
  });

  it('allows admins through the guard', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { roles: ['admin'], raw: {} });
      await next();
    });
    app.use('*', withControlPlaneAccessGuard());
    app.get('/api/v1/roles', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/roles');

    expect(res.status).toBe(200);
  });
});

describe('control-plane access guard — self-introspection (B100)', () => {
  function appFor(auth: AppEnv['Variables']['auth'] | undefined) {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      if (auth) c.set('auth', auth);
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_self');
      await next();
    });
    app.use('*', withControlPlaneAccessGuard());
    app.get('/api/v1/permissions/me', (c) => c.json({ data: { mine: true } }));
    app.post('/api/v1/permissions/check', (c) => c.json({ data: { allowed: true } }));
    app.get('/api/v1/permissions/other', (c) => c.json({ data: {} }));
    return app;
  }

  // A user invited with a role carries that role's id, not the name `admin`.
  const invited = { email: 'editor@example.com', roles: ['hJ9kYcDumu7Knxet_NSkE'], raw: {} };

  it('lets any signed-in principal read its own permission bundle', async () => {
    const res = await appFor(invited).request('/api/v1/permissions/me');
    expect(res.status).toBe(200);
  });

  it('keeps the rest of /permissions admin-only', async () => {
    const app = appFor(invited);
    expect((await app.request('/api/v1/permissions/check', { method: 'POST' })).status).toBe(403);
    expect((await app.request('/api/v1/permissions/other')).status).toBe(403);
  });

  it('does not open /permissions/me to other methods or to anonymous callers', async () => {
    expect((await appFor(invited).request('/api/v1/permissions/me', { method: 'POST' })).status).toBe(403);
    expect((await appFor(undefined).request('/api/v1/permissions/me')).status).toBe(403);
  });
});

describe('control-plane access guard — site admin by role id (B101)', () => {
  const adminBundle = { admin: true } as never;
  const memberBundle = { admin: false } as never;
  const invited = { userId: 'u_1', email: 'ops@example.com', roles: ['hJ9kYcDumu7Knxet_NSkE'], raw: { aud: 'studio' } };

  function request(auth: Record<string, unknown>, access: unknown) {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      c.set('auth', auth as never);
      if (access) c.set('access', access as never);
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_b101');
      await next();
    });
    app.use('*', withControlPlaneAccessGuard());
    app.get('/api/v1/roles', (c) => c.json({ ok: true }));
    return app.request('/api/v1/roles');
  }

  it('admits an invited user whose role has admin access in this site', async () => {
    expect((await request(invited, adminBundle)).status).toBe(200);
  });

  it('still refuses a user whose role has no admin access, or with no bundle', async () => {
    expect((await request(invited, memberBundle)).status).toBe(403);
    expect((await request(invited, undefined)).status).toBe(403);
  });

  it('never admits API keys, anonymous or frontend-audience sessions on the bundle alone', () => {
    expect(hasSiteAdminAccess({ ...invited, apiKeyId: 'k_1' } as never, adminBundle)).toBe(false);
    expect(hasSiteAdminAccess({ ...invited, type: 'anonymous' } as never, adminBundle)).toBe(false);
    expect(hasSiteAdminAccess({ ...invited, raw: { aud: 'frontend' } } as never, adminBundle)).toBe(false);
    expect(hasSiteAdminAccess({ roles: [], raw: {} } as never, adminBundle)).toBe(false);
  });
});
