import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';

/**
 * `/api/v1/admin/sites` containment: the admin router is site-scoped
 * (`requireSiteAdmin` only proves admin of the `X-Lumi-Site` site), so creating
 * a site or deleting a *different* site must need the explicit
 * `LUMIBASE_ALLOW_ADMIN_SITE_MANAGEMENT=true` opt-in.
 */

vi.mock('../../services/permission-service', () => ({
  PermissionService: class {
    async bundle() {
      return { admin: true };
    }
  },
}));

vi.mock('../../services/official-extension-reconciler', () => ({
  reconcileOfficialExtensions: vi.fn(async () => undefined),
}));

const { adminRouter } = await import('../admin');

interface Calls {
  inserts: Array<Record<string, unknown>>;
  deletes: number;
}

function makeDb(calls: Calls) {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        calls.inserts.push(v);
        return { returning: async () => [{ ...v }] };
      },
    }),
    delete: () => ({
      where: async () => {
        calls.deletes++;
        return [];
      },
    }),
  };
}

function appFor(env: Record<string, string>, calls: Calls) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user_1', roles: ['admin'], raw: {} } as never);
    c.set('siteId', 'site_own');
    c.set('runtime', { cache: undefined } as never);
    c.set('db', makeDb(calls) as never);
    await next();
  });
  app.route('/admin', adminRouter);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, env as never),
  };
}

const ENABLED = { LUMIBASE_ALLOW_ADMIN_SITE_MANAGEMENT: 'true' };

function postSite(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('admin site management containment', () => {
  let calls: Calls;
  beforeEach(() => {
    calls = { inserts: [], deletes: 0 };
  });

  it('refuses to delete a foreign site for a plain site admin', async () => {
    const app = appFor({}, calls);
    const res = await app.request('/admin/sites/site_victim', { method: 'DELETE' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('FORBIDDEN');
    expect(calls.deletes).toBe(0);
  });

  it('allows a site admin to delete their own site', async () => {
    const app = appFor({}, calls);
    const res = await app.request('/admin/sites/site_own', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(calls.deletes).toBe(1);
  });

  it('allows deleting another site when site management is enabled', async () => {
    const app = appFor(ENABLED, calls);
    const res = await app.request('/admin/sites/site_other', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(calls.deletes).toBe(1);
  });

  it('refuses site creation for a plain site admin', async () => {
    const app = appFor({}, calls);
    const res = await app.request('/admin/sites', postSite({ id: 'site_new', name: 'New' }));
    expect(res.status).toBe(403);
    expect(calls.inserts).toHaveLength(0);
  });

  it('refuses site creation when the flag is anything but "true"', async () => {
    const app = appFor({ LUMIBASE_ALLOW_ADMIN_SITE_MANAGEMENT: '1' }, calls);
    const res = await app.request('/admin/sites', postSite({ id: 'site_new', name: 'New' }));
    expect(res.status).toBe(403);
    expect(calls.inserts).toHaveLength(0);
  });

  it('creates a site when site management is enabled', async () => {
    const app = appFor(ENABLED, calls);
    const res = await app.request('/admin/sites', postSite({ id: 'site_new', name: 'New' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string } };
    expect(body.data).toMatchObject({ id: 'site_new', name: 'New' });
    expect(calls.inserts).toEqual([{ id: 'site_new', name: 'New' }]);
  });

  it.each([
    [{ name: 'Missing id' }],
    [{ id: 'bad id!', name: 'x' }],
    [{ id: 'site_x', name: '' }],
    [{ id: 'site_x', name: 'x', ownerId: 'u' }],
  ])('rejects an invalid create body %j', async (payload) => {
    const app = appFor(ENABLED, calls);
    const res = await app.request('/admin/sites', postSite(payload));
    expect(res.status).toBe(400);
    expect(calls.inserts).toHaveLength(0);
  });

  it('rejects a non-JSON create body', async () => {
    const app = appFor(ENABLED, calls);
    const res = await app.request('/admin/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});
