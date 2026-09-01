import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../env';
import { withAuth } from '../middleware/auth';
import { mergeRequestContext } from '../middleware/request-context';
import { withSiteMembership } from '../middleware/site-membership';
import { withStudioAccess } from '../middleware/studio-access';

/**
 * Query-count guard for middleware consolidation (Req 10.4; task 11.3).
 *
 * Counts mocked Drizzle `select()` calls through the auth → membership →
 * studio chain on a typical content-plane GET. After the
 * Request_Context_Bundle refactor, `withSiteMembership` must not re-query
 * user/membership rows that `withAuth` already resolved.
 */

const bundleMock = vi.hoisted(() => vi.fn());

vi.mock('../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: bundleMock };
  }),
}));

const SITE_ID = 'site_1';
const USER_ID = 'user_1';

function makeCountingDb(results: unknown[][]): { db: Database; selectCount: () => number } {
  let count = 0;
  let selectCalls = 0;
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(results[count++] ?? []),
  };
  const db = {
    select: () => {
      selectCalls += 1;
      return fluent;
    },
    update: () => fluent,
    insert: () => ({ values: () => Promise.resolve() }),
  } as unknown as Database;
  return { db, selectCount: () => selectCalls };
}

function buildContentPlaneApp(db: Database, auth?: AuthPrincipal): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', SITE_ID);
    c.set('db', db);
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    if (auth) {
      c.set('auth', auth);
      mergeRequestContext(c, {
        user: {
          id: USER_ID,
          externalId: null,
          email: 'member@example.com',
          isBootstrap: false,
        },
        membership: { roleId: 'role_member' },
      });
    }
    await next();
  });
  if (!auth) {
    app.use('*', withAuth());
  }
  app.use('*', withSiteMembership(), withStudioAccess());
  app.get('/api/v1/items/posts', (c) => c.json({ ok: true }));
  return app;
}

describe('middleware query count — content-plane GET (task 11.3)', () => {
  it('uses ≤3 select queries when requestContext is populated by withAuth', async () => {
    bundleMock.mockResolvedValue({
      admin: false,
      appAccess: true,
      tfaRequired: false,
      byKey: {},
      roles: [],
      policies: [],
    });

    const memberAuth: AuthPrincipal = {
      userId: USER_ID,
      email: 'member@example.com',
      roles: ['role_member'],
      raw: { aud: 'studio' },
    };

    const { db, selectCount } = makeCountingDb([]);
    const app = buildContentPlaneApp(db, memberAuth);

    const res = await app.request('/api/v1/items/posts');
    expect(res.status).toBe(200);
    expect(selectCount()).toBeLessThanOrEqual(3);
    expect(selectCount()).toBe(0);
  });

  it('withAuth + membership on content path stays ≤3 selects (JWT path simulated)', async () => {
    bundleMock.mockResolvedValue({
      admin: false,
      appAccess: true,
      tfaRequired: false,
      byKey: {},
      roles: [],
      policies: [],
    });

    const jwtResults = [
      [], // API-key lookup miss
      [{ id: USER_ID, status: 'active', isBootstrap: false, tokenVersion: 0 }],
      [{ roleId: 'role_member' }],
    ];
    const { db, selectCount } = makeCountingDb(jwtResults);

    process.env.JWT_SECRET = 'count-test-secret';
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({
      userId: USER_ID,
      siteId: SITE_ID,
      email: 'member@example.com',
      tokenVersion: 0,
      aud: 'studio',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    const app = buildContentPlaneApp(db);
    const res = await app.request(
      '/api/v1/items/posts',
      { headers: { authorization: `Bearer ${token}` } },
      { JWT_SECRET: 'count-test-secret' },
    );

    expect(res.status).toBe(200);
    expect(selectCount()).toBeLessThanOrEqual(3);
    expect(selectCount()).toBe(3);
  });
});
