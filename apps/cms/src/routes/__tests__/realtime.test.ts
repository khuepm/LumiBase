import { Hono } from 'hono';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { realtimeRouter } from '../realtime';

const JWT_SECRET = 'test-secret-please-ignore';

/** Mount the realtime router behind a middleware that injects auth + siteId. */
function mount(auth: AuthPrincipal | null, siteId = 'site-1') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    c.set('siteId', siteId);
    await next();
  });
  app.route('/realtime', realtimeRouter);
  return app;
}

const ENV = { JWT_SECRET } as unknown as AppEnv['Bindings'];

async function decode(ticket: string) {
  const { payload } = await jwtVerify(ticket, new TextEncoder().encode(JWT_SECRET), {
    algorithms: ['HS256'],
  });
  return payload;
}

describe('POST /realtime/ticket (studio)', () => {
  it('401 when unauthenticated', async () => {
    const res = await mount(null).request('/realtime/ticket', { method: 'POST' }, ENV);
    expect(res.status).toBe(401);
  });

  it('issues a studio ticket for an admin', async () => {
    const app = mount({ userId: 'u1', roles: ['admin'], raw: {} });
    const res = await app.request('/realtime/ticket', { method: 'POST' }, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ticket: string } };
    const payload = await decode(body.data.ticket);
    expect(payload).toMatchObject({ plane: 'studio', userId: 'u1', siteId: 'site-1' });
    // No db/runtime in this harness → the collection allowlist resolves
    // fail-closed to [] (never a wide-open ticket on error).
    expect(payload.collections).toEqual([]);
  });
});

describe('POST /realtime/audience-ticket (end-user)', () => {
  it('403 for an admin (non-frontend) principal', async () => {
    const app = mount({ userId: 'u1', isFrontendUser: false, raw: {} });
    const res = await app.request('/realtime/audience-ticket', { method: 'POST' }, ENV);
    expect(res.status).toBe(403);
  });

  it('issues a public ticket carrying subjectId + granted channels', async () => {
    const app = mount({
      isFrontendUser: true,
      raw: { citizenID: 'C-42', channels: ['order:1'] },
    });
    const res = await app.request(
      '/realtime/audience-ticket',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: ['order:1', 'order:evil'] }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ticket: string; subjectId: string; channels: string[] } };
    expect(body.data.subjectId).toBe('C-42');
    expect(body.data.channels).toContain('order:1');
    expect(body.data.channels).not.toContain('order:evil');

    const payload = await decode(body.data.ticket);
    expect(payload).toMatchObject({ plane: 'public', subjectId: 'C-42', siteId: 'site-1' });
  });
});

describe('GET /realtime (upgrade)', () => {
  it('returns status JSON without an Upgrade header', async () => {
    const res = await mount(null).request('/realtime', {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('realtime_ready');
  });

  it('401 with an Upgrade header but no ticket', async () => {
    const res = await mount(null).request('/realtime', { headers: { Upgrade: 'websocket' } }, ENV);
    expect(res.status).toBe(401);
  });

  it('401 on an invalid ticket', async () => {
    const res = await mount(null).request(
      '/realtime?ticket=not-a-jwt',
      { headers: { Upgrade: 'websocket' } },
      ENV,
    );
    expect(res.status).toBe(401);
  });

  it('501 when no SITE_ROOM binding (Docker path) with a valid ticket', async () => {
    // First get a valid ticket.
    const app = mount({ userId: 'u1', roles: [], raw: {} });
    const ticketRes = await app.request('/realtime/ticket', { method: 'POST' }, ENV);
    const { data } = (await ticketRes.json()) as { data: { ticket: string } };

    const res = await app.request(
      `/realtime?ticket=${encodeURIComponent(data.ticket)}`,
      { headers: { Upgrade: 'websocket' } },
      ENV,
    );
    expect(res.status).toBe(501);
  });
});
