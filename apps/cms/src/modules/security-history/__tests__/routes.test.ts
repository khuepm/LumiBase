import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import { MemoryRateLimiter } from '@lumibase/runtime';
import type { AppEnv } from '../../../env';

/**
 * #739 — `/api/v1/me/security-history` route: the caller's own history only,
 * site scope by default, `scope=account` limited to the caller's
 * memberships, a validated cursor/limit, and a rate-limited CSV/JSON export.
 * The query service is mocked; its SQL is covered in `service.test.ts`.
 */

const svc = vi.hoisted(() => ({
  query: vi.fn(),
  exportRows: vi.fn(),
  memberships: [] as Array<{ siteId: string }>,
  user: { id: 'usr_1', email: 'me@example.com', createdAt: new Date('2026-01-01T00:00:00Z') } as
    | { id: string; email: string; createdAt: Date }
    | undefined,
  systemDb: {} as unknown,
}));

vi.mock('../service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../service')>();
  return { ...actual, querySecurityHistory: svc.query, exportSecurityHistory: svc.exportRows };
});

vi.mock('../../../middleware/db', () => ({
  systemDbFor: () => svc.systemDb,
}));

const { securityHistoryRouter } = await import('../routes');
const { encodeCursor } = await import('../../audit/routes');

/** `select().from().where().limit()` → the user row; `…where()` → memberships. */
function selectChain(result: () => unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = result();
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
  };
}

const requestDb = selectChain(() => (svc.user ? [svc.user] : []));

function buildApp(auth: Record<string, unknown> | null, limiter = new MemoryRateLimiter()): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', requestDb as unknown as Database);
    c.set('siteId', 'site-a');
    c.set('runtime', { rateLimiter: limiter } as never);
    c.set('auth', (auth ?? {}) as never);
    await next();
  });
  app.route('/api/v1/me/security-history', securityHistoryRouter);
  return app;
}

const me = { userId: 'usr_1', email: 'me@example.com', roles: ['member'], raw: { aud: 'frontend' } };

const item = {
  id: 'aud_1',
  kind: 'sign_in',
  occurredAt: '2026-11-14T10:00:00.000Z',
  siteId: 'site-a',
  ipApprox: '203.0.113.x',
  userAgent: '@SUM(1+1)',
  countryCode: 'VN',
  details: {},
};

beforeEach(() => {
  svc.query.mockReset();
  svc.exportRows.mockReset();
  svc.user = { id: 'usr_1', email: 'me@example.com', createdAt: new Date('2026-01-01T00:00:00Z') };
  svc.memberships = [{ siteId: 'site-b' }, { siteId: 'site-a' }];
  svc.systemDb = selectChain(() => svc.memberships);
  svc.query.mockResolvedValue({ items: [item], nextCursor: 'next' });
  svc.exportRows.mockResolvedValue({ items: [item], truncated: false });
});

describe('GET /api/v1/me/security-history', () => {
  it('returns the caller\'s history for the current site (members too)', async () => {
    const res = await buildApp(me).request('/api/v1/me/security-history');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ data: [item], meta: { nextCursor: 'next', limit: 25, scope: 'site' } });
    expect(svc.query).toHaveBeenCalledWith(requestDb, {
      subject: { userId: 'usr_1', email: 'me@example.com', createdAt: svc.user!.createdAt },
      siteIds: ['site-a'],
      cursor: null,
      limit: 25,
    });
  });

  it('takes the subject from the session, never from the query string', async () => {
    await buildApp(me).request('/api/v1/me/security-history?userId=usr_other&email=victim@example.com');
    expect(svc.query.mock.calls[0]![1].subject.userId).toBe('usr_1');
  });

  it('scope=account reads the caller\'s member sites on the system handle', async () => {
    const res = await buildApp(me).request('/api/v1/me/security-history?scope=account');
    expect(res.status).toBe(200);
    const [db, q] = svc.query.mock.calls[0]!;
    expect(db).toBe(svc.systemDb);
    expect([...q.siteIds].sort()).toEqual(['site-a', 'site-b']);
  });

  it('decodes a valid cursor and passes the limit', async () => {
    const ts = new Date('2026-11-14T09:00:00.000Z');
    const cursor = encodeCursor(ts, 'aud_9');
    await buildApp(me).request(`/api/v1/me/security-history?limit=5&cursor=${encodeURIComponent(cursor)}`);
    expect(svc.query.mock.calls[0]![1]).toMatchObject({ limit: 5, cursor: { timestamp: ts, id: 'aud_9' } });
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=abc'],
    ['cursor=%%%'],
    ['scope=everyone'],
  ])('rejects %s with 400', async (qs) => {
    const res = await buildApp(me).request(`/api/v1/me/security-history?${qs}`);
    expect(res.status).toBe(400);
    expect(svc.query).not.toHaveBeenCalled();
  });

  it('401s a principal without a user (API key / anonymous)', async () => {
    const res = await buildApp({ apiKeyId: 'k1', roles: ['admin'] }).request('/api/v1/me/security-history');
    expect(res.status).toBe(401);
  });

  it('401s when the user row is gone', async () => {
    svc.user = undefined;
    const res = await buildApp(me).request('/api/v1/me/security-history');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/me/security-history/export', () => {
  it('downloads JSON by default', async () => {
    const res = await buildApp(me).request('/api/v1/me/security-history/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="security-history-\d{4}-\d{2}-\d{2}\.json"/);
    expect(res.headers.get('x-export-truncated')).toBe('false');
    const body = (await res.json()) as { data: unknown[]; meta: { count: number; truncated: boolean; scope: string } };
    expect(body.data).toEqual([item]);
    expect(body.meta).toMatchObject({ count: 1, truncated: false, scope: 'site' });
  });

  it('downloads a formula-safe CSV', async () => {
    const res = await buildApp(me).request('/api/v1/me/security-history/export?format=csv&scope=account');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text.split('\r\n')[0]).toBe('occurredAt,kind,siteId,ipApprox,countryCode,userAgent,details');
    expect(text).toContain(`'@SUM(1+1)`);
    expect([...svc.exportRows.mock.calls[0]![1].siteIds].sort()).toEqual(['site-a', 'site-b']);
  });

  it('rejects an unknown format', async () => {
    expect((await buildApp(me).request('/api/v1/me/security-history/export?format=xml')).status).toBe(400);
  });

  it('rate-limits exports per user', async () => {
    const limiter = new MemoryRateLimiter();
    const app = buildApp(me, limiter);
    for (let i = 0; i < 10; i++) {
      expect((await app.request('/api/v1/me/security-history/export')).status).toBe(200);
    }
    const blocked = await app.request('/api/v1/me/security-history/export');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });
});
