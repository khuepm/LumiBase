import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../env';
import { pushRouter } from './push';

/**
 * Push router tests (push-noti feature). Focus on the per-tenant status/test
 * surface and graceful behaviour when transports are unconfigured. Delivery
 * itself is covered by the broadcaster + web-push unit tests.
 */

/** Minimal chainable db stub: select(...).from(...).where(...) → rows. */
function fakeDb(countRow: number) {
  const builder = {
    from: () => builder,
    where: () => Promise.resolve([{ n: countRow }]),
  };
  return { select: () => builder } as unknown as AppEnv['Variables']['db'];
}

function testApp(countRow = 0) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { roles: ['admin'], userId: 'u1', raw: {} });
    c.set('siteId', 'site-a');
    c.set('db', fakeDb(countRow));
    return next();
  });
  app.route('/push', pushRouter);
  return app;
}

describe('push router', () => {
  it('reports both transports off and the tenant subscription count when unconfigured', async () => {
    const res = await testApp(3).request('/push/status');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: { vapidConfigured: false, realtimeAvailable: false, subscriptions: 3 },
    });
  });

  it('reflects configured VAPID + SiteRoom binding from env', async () => {
    const res = await testApp(0).request('/push/status', {}, {
      VAPID_PUBLIC_KEY: 'BPublicKey',
      SITE_ROOM: {} as never,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { vapidConfigured: boolean; realtimeAvailable: boolean } };
    expect(body.data.vapidConfigured).toBe(true);
    expect(body.data.realtimeAvailable).toBe(true);
  });

  it('returns 404 for the public key when VAPID is unset', async () => {
    const res = await testApp().request('/push/vapid-public-key');
    expect(res.status).toBe(404);
  });

  it('dispatches a site-scoped test notification (no-op transports → still ok)', async () => {
    const res = await testApp(0).request('/push/test', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dispatched: boolean } };
    expect(body.data.dispatched).toBe(true);
  });
});
