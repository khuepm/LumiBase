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

  /**
   * The legacy surface is the third decision entry point, and it must stay
   * admin-only for the same reason as the other two (#481 B80).
   *
   * Approvals execute under the REQUESTER's row/field scope, and the argument that
   * this needs no intersection with the decider's scope rests on deciders being
   * admins — who have no mask to intersect. A member holding the write permission
   * the parked action needs is the closest near-miss to that assumption, so it is
   * pinned here rather than left to the gate's implementation details.
   */
  it('forbids a member who holds item write permissions', async () => {
    const writer: AuthPrincipal = {
      userId: 'usr_writer',
      email: 'writer@example.com',
      // Capability tokens never arrive through `roles`; this is the shape a real
      // member has, which is why the gate asks the resolver instead.
      roles: ['member', 'items:write'],
      raw: {},
    };
    const app = buildApp(writer);

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
