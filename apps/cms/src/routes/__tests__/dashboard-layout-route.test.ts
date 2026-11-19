import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/** Route guards for the Studio dashboard layout API (#691). */

const state = { admin: false };
const calls: Array<{ op: string; userId: string | null }> = [];

vi.mock('../../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (c: { json: (b: unknown, s: number) => Response }, next: () => Promise<void>) =>
    state.admin ? next() : c.json({ errors: [{ code: 'FORBIDDEN' }] }, 403),
}));
vi.mock('../../modules/audit/logger', () => ({ AuditLogger: class { async write() {} } }));
vi.mock('../../services/dashboard-layout-service', async (orig) => {
  const actual = await orig<typeof import('../../services/dashboard-layout-service')>();
  return {
    ...actual,
    DashboardLayoutService: class {
      async effective(userId: string | null) {
        calls.push({ op: 'effective', userId });
        return { layout: null, source: 'default', updatedAt: null };
      }
      async siteDefault() {
        return { layout: null, source: 'default', updatedAt: null };
      }
      async save(userId: string | null, input: unknown) {
        calls.push({ op: 'save', userId });
        return actual.parseDashboardLayout(input);
      }
      async reset(userId: string | null) {
        calls.push({ op: 'reset', userId });
        return true;
      }
    },
  };
});

const { dashboardLayoutRouter } = await import('../dashboard-layout');

function app(userId: string | null) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId' as never, 'site_1' as never);
    c.set('db' as never, {} as never);
    c.set('auth' as never, (userId ? { userId, raw: {} } : { apiKeyId: 'k1', raw: {} }) as never);
    await next();
  });
  a.route('/dashboard', dashboardLayoutRouter);
  return a;
}

const layout = { version: 1, widgets: [{ id: 'a', type: 'collections', x: 0, y: 0, w: 6, h: 3 }] };
const put = (path: string, body: unknown) =>
  ({ method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as RequestInit;

beforeEach(() => {
  state.admin = false;
  calls.length = 0;
});

describe('dashboard layout routes', () => {
  it('reads and saves the caller’s own layout', async () => {
    const a = app('u1');
    expect((await a.request('/dashboard/layout')).status).toBe(200);
    const res = await a.request('/dashboard/layout', put('/layout', { layout }));
    expect(res.status).toBe(200);
    expect(calls).toContainEqual({ op: 'save', userId: 'u1' });
  });

  it('refuses a personal layout without a user principal', async () => {
    const res = await app(null).request('/dashboard/layout', put('/layout', { layout }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]?.code).toBe('USER_REQUIRED');
  });

  it('validates the layout', async () => {
    const res = await app('u1').request('/dashboard/layout', put('/layout', { layout: { version: 1, widgets: [{ id: 'a', type: 'x', x: 11, y: 0, w: 4, h: 1 }] } }));
    expect(res.status).toBe(400);
  });

  it('lets only site admins set the site default', async () => {
    expect((await app('u1').request('/dashboard/layout/site-default', put('', { layout }))).status).toBe(403);
    state.admin = true;
    const res = await app('u1').request('/dashboard/layout/site-default', put('', { layout }));
    expect(res.status).toBe(200);
    expect(calls).toContainEqual({ op: 'save', userId: null });
  });
});
