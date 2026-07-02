import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { withSiteMembership } from '../site-membership';

const bundleMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(() => ({ bundle: bundleMock })),
}));

function makeFakeDb(results: unknown[][]): Database {
  let selectCount = 0;
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(results[selectCount++] ?? []),
  };
  return { select: () => fluent } as unknown as Database;
}

function buildApp(auth: AuthPrincipal, db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    c.set('siteId', 'victim-site');
    c.set('db', db);
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('*', withSiteMembership());
  app.get('/api/v1/items/posts', (c) => c.json({ ok: true }));
  return app;
}

describe('withSiteMembership', () => {
  it('rejects user principals that are not members of the selected site', async () => {
    const app = buildApp(
      { userId: 'user-1', email: 'user@example.com', raw: {} },
      makeFakeDb([
        [{ id: 'user-1', externalId: null, email: 'user@example.com', isBootstrap: false }],
        [],
      ]),
    );

    const res = await app.request('/api/v1/items/posts');
    const body = await res.json() as { errors: Array<{ code: string }> };

    expect(res.status).toBe(403);
    expect(body.errors[0]?.code).toBe('TENANT_FORBIDDEN');
  });

  it('preserves local dev-admin bypass for development tokens', async () => {
    const app = buildApp(
      { email: 'dev@example.com', roles: ['admin'], raw: { dev: true } },
      makeFakeDb([]),
    );

    const res = await app.request('/api/v1/items/posts');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps the Cloudflare Access admin fallback working when no matching users row exists', async () => {
    bundleMock.mockResolvedValue({
      admin: true,
      appAccess: true,
      tfaRequired: false,
      byKey: {},
      roles: [],
      policies: [],
    });
    const app = buildApp(
      { externalId: 'cf-access-sub', email: 'operator@example.com', roles: ['admin'], raw: {} },
      makeFakeDb([[]]),
    );

    const res = await app.request('/api/v1/items/posts');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('still rejects a non-admin externalId principal with no matching users row', async () => {
    const app = buildApp(
      { externalId: 'unknown-sub', email: 'stranger@example.com', roles: [], raw: {} },
      makeFakeDb([[]]),
    );

    const res = await app.request('/api/v1/items/posts');
    const body = await res.json() as { errors: Array<{ code: string }> };

    expect(res.status).toBe(403);
    expect(body.errors[0]?.code).toBe('TENANT_FORBIDDEN');
  });
});
