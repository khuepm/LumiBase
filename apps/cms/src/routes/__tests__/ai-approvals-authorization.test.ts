import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, AuthPrincipal } from '../../env';
import { aiRouter } from '../ai';

function buildApp(auth: AuthPrincipal): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/ai', aiRouter);
  return app;
}

const memberPrincipal: AuthPrincipal = {
  userId: 'usr_member',
  email: 'member@example.com',
  roles: ['member'],
  raw: {},
};

describe('AI approval routes authorization', () => {
  it('forbids non-admin users from listing pending approvals', async () => {
    const app = buildApp(memberPrincipal);

    const res = await app.request('/ai/approvals');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });

  it('forbids non-admin users from deciding pending approvals', async () => {
    const app = buildApp(memberPrincipal);

    const res = await app.request('/ai/approvals/appr_1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });
});
