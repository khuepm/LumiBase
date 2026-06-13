import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../site-admin';

function makeApp(auth: AppEnv['Variables']['auth'], siteId = 'site_a') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    c.set('siteId', siteId);
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
    return next();
  });
  app.use('*', requireSiteAdmin());
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}

describe('requireSiteAdmin', () => {
  it('rejects authenticated non-admin principals before sensitive route handlers run', async () => {
    const app = makeApp({
      email: 'attacker@example.com',
      externalId: 'dev_attacker',
      roles: ['member'],
      raw: { dev: true },
    });

    const res = await app.request('/probe');
    const body = await res.json() as { errors: Array<{ code: string }> };

    expect(res.status).toBe(403);
    expect(body.errors[0]?.code).toBe('FORBIDDEN');
  });

  it('allows explicit admin dev principals for local development', async () => {
    const app = makeApp({
      email: 'admin@example.com',
      externalId: 'dev_admin',
      roles: ['admin'],
      raw: { dev: true },
    });

    const res = await app.request('/probe');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
