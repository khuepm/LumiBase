import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { usersRouter } from '../users';

function appWithDb() {
  const select = vi.fn();
  const insert = vi.fn();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site_1');
    c.set('auth', { roles: ['admin'], raw: { dev: true } });
    c.set('db', { select, insert } as never);
    await next();
  });
  app.route('/users', usersRouter);
  return { app, select, insert };
}

describe('POST /users/invite validation', () => {
  it('rejects an empty roleId with 400 before touching the database', async () => {
    // `roleId: ""` used to be stored verbatim as the membership's role id.
    const { app, select, insert } = appWithDb();
    const res = await app.request('/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', roleId: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'VALIDATION' }] });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('answers a malformed body with 400, not 500', async () => {
    const { app } = appWithDb();
    const res = await app.request('/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });
});
