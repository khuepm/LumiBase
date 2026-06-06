import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { isAdminPrincipal, isControlPlanePath, withControlPlaneAccessGuard } from '../control-plane-access-guard';

describe('control-plane access guard helpers', () => {
  it('identifies system administration paths', () => {
    expect(isControlPlanePath('/api/v1/roles')).toBe(true);
    expect(isControlPlanePath('/api/v1/roles/role-1/users')).toBe(true);
    expect(isControlPlanePath('/api/v1/items/posts')).toBe(false);
  });

  it('recognizes admin principals', () => {
    expect(isAdminPrincipal({ roles: ['admin'], raw: {} })).toBe(true);
    expect(isAdminPrincipal({ roles: ['administrator'], raw: {} })).toBe(true);
    expect(isAdminPrincipal({ roles: ['member'], raw: {} })).toBe(false);
  });
});

describe('control-plane access guard middleware', () => {
  it('fails closed on non-admin access to system routes', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { roles: ['member'], raw: {} });
      await next();
    });
    app.use('*', withControlPlaneAccessGuard());
    app.get('/api/v1/roles', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/roles');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'CONTROL_PLANE_FORBIDDEN' }] });
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
