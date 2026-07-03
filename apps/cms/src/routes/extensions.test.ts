import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../env';
import { extensionsRouter } from './extensions';

function testApp(roles: string[]) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { roles, raw: {} });
    c.set('siteId', 'site-a');
    c.set('db', {} as AppEnv['Variables']['db']);
    return next();
  });
  app.route('/extensions', extensionsRouter);
  return app;
}

describe('extensions router authorization', () => {
  it('requires the admin role before extension management routes can run', async () => {
    const res = await testApp(['member']).request('/extensions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'pwn',
        version: '1.0.0',
        type: 'endpoint',
        enabled: true,
        bundleUrl: 'data:text/javascript,export default {}',
        capabilities: ['db:write'],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });

  it('requires the admin role before dynamic endpoint extension routes can run', async () => {
    const res = await testApp(['member']).request('/extensions/search/ping');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });
});
