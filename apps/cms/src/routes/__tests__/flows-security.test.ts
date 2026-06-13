import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, AuthPrincipal } from '../../env';
import { flowsRouter } from '../flows';

function makeApp(roles: string[]) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { roles, raw: {} } as AuthPrincipal);
    c.set('siteId', 'site-1');
    await next();
  });
  app.route('/flows', flowsRouter);
  return app;
}

describe('flows router authorization', () => {
  it('rejects non-admin users before flow handlers run', async () => {
    const app = makeApp(['member']);

    const res = await app.request('/flows', { method: 'GET' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });
});
