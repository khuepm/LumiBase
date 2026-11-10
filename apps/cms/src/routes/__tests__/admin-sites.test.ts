import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { adminRouter } from '../admin';

describe('retired admin site-management test routes', () => {
  it.each([['POST', '/admin/sites'], ['DELETE', '/admin/sites/foreign-site']])('%s %s is absent even for a trusted admin', async (method, path) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('siteId', 'own-site');
      c.set('auth', { roles: ['admin'], raw: { dev: true } });
      await next();
    });
    app.route('/admin', adminRouter);
    expect((await app.request(path, { method })).status).toBe(404);
  });
});
