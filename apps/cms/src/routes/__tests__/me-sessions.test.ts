import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';

/**
 * `/api/v1/me/sessions` (#730): the caller's session list marks the current
 * device, `DELETE /:id` revokes one session, and `DELETE ?scope=others`
 * signs out every other device. The refresh-token service and the audit
 * logger are mocked — their own behaviour is covered in
 * `services/auth/__tests__/refresh-token*.test.ts`.
 */

const svc = vi.hoisted(() => ({
  listUserSessions: vi.fn(),
  revokeSessionById: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeAllRefreshTokens: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return {
    ...actual,
    listUserSessions: svc.listUserSessions,
    revokeSessionById: svc.revokeSessionById,
    revokeOtherSessions: svc.revokeOtherSessions,
    revokeAllRefreshTokens: svc.revokeAllRefreshTokens,
  };
});

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write(entry: unknown) {
      svc.audit(entry);
      return Promise.resolve();
    }
  },
}));

const { meRouter } = await import('../auth');

function buildApp(raw: Record<string, unknown>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as Database);
    c.set('siteId', 'site-a');
    c.set('auth', { userId: 'usr_1', email: 'user@example.com', roles: ['member'], raw } as never);
    await next();
  });
  app.route('/api/v1/me', meRouter);
  return app;
}

const session = (sessionId: string, lastSeen: number) => ({
  id: `row-${sessionId}`,
  sessionId,
  audience: 'studio',
  startedAt: new Date(1000),
  lastSeenAt: new Date(lastSeen),
  createdAt: new Date(lastSeen),
  expiresAt: new Date(9e12),
  lastIp: null,
  lastUserAgent: null,
});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
});

describe('GET /api/v1/me/sessions', () => {
  it('marks the session that made the request as current', async () => {
    svc.listUserSessions.mockResolvedValue([session('fam-b', 3000), session('fam-a', 2000)]);
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ sessionId: string; current: boolean }> };
    expect(body.data.map((s) => [s.sessionId, s.current])).toEqual([
      ['fam-b', false],
      ['fam-a', true],
    ]);
  });

  it('marks nothing current for a legacy token without sid', async () => {
    svc.listUserSessions.mockResolvedValue([session('fam-a', 2000)]);
    const res = await buildApp({}).request('/api/v1/me/sessions');
    const body = (await res.json()) as { data: Array<{ current: boolean }> };
    expect(body.data[0]!.current).toBe(false);
  });
});

describe('DELETE /api/v1/me/sessions/:id', () => {
  it('revokes another device and audits it', async () => {
    svc.revokeSessionById.mockResolvedValue('fam-b');
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions/fam-b', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id: 'fam-b', sessionId: 'fam-b', revoked: true, current: false },
    });
    expect(svc.revokeSessionById).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_1', 'fam-b');
    expect(svc.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'session_revoked',
        metadata: expect.objectContaining({ sessionId: 'fam-b', current: false }),
      }),
    );
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('clears the refresh cookie when the current session is revoked', async () => {
    svc.revokeSessionById.mockResolvedValue('fam-a');
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions/fam-a', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { current: boolean } }).data.current).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('lumibase_refresh=');
  });

  it('404s for a session that is not the caller’s or already dead', async () => {
    svc.revokeSessionById.mockResolvedValue(null);
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions/nope', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(svc.audit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/me/sessions', () => {
  it('scope=others keeps the current session and reports the count', async () => {
    svc.revokeOtherSessions.mockResolvedValue(2);
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions?scope=others', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'other_sessions_revoked', revoked: 2 } });
    expect(svc.revokeOtherSessions).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_1', 'fam-a');
    expect(svc.revokeAllRefreshTokens).not.toHaveBeenCalled();
    expect(svc.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sessions_revoked',
        metadata: expect.objectContaining({ scope: 'others', revoked: 2 }),
      }),
    );
  });

  it('scope=others refuses a token without sid instead of signing everyone out', async () => {
    const res = await buildApp({}).request('/api/v1/me/sessions?scope=others', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(svc.revokeOtherSessions).not.toHaveBeenCalled();
    expect(svc.revokeAllRefreshTokens).not.toHaveBeenCalled();
  });

  it('default scope revokes everything, clears the cookie and audits', async () => {
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(svc.revokeAllRefreshTokens).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_1');
    expect(res.headers.get('set-cookie')).toContain('lumibase_refresh=');
    expect(svc.audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sessions_revoked', metadata: expect.objectContaining({ scope: 'all' }) }),
    );
  });

  it('rejects an unknown scope', async () => {
    const res = await buildApp({ sid: 'fam-a' }).request('/api/v1/me/sessions?scope=mine', {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });
});
