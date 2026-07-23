import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import type { PermissionBundle } from '../../services/permission-service';
import { withAuth } from '../auth';
import { withSiteMembership } from '../site-membership';
import { withStudioAccess } from '../studio-access';

/**
 * Request_Context_Bundle — request-scoped identity cache
 * (high-load-cache-readiness Req 10; design §6.4).
 *
 * These are the behavioural-matrix + query-count tests the DoD asks for
 * (Req 10.3, 10.4). They wire the real `withAuth → withSiteMembership →
 * withStudioAccess` chain over a query-counting fake DB and prove:
 *
 *  - guard semantics are unchanged (principal × route → status matrix);
 *  - the identity lookups (`users`, `userSites`) run exactly once per request
 *    (in `withAuth`) and are NOT repeated by `withSiteMembership`;
 *  - `PermissionService.bundle()` runs exactly once per request — the bundle
 *    `withSiteMembership` computes is reused by `withStudioAccess` instead of
 *    being recomputed;
 *  - each guard still queries on its own when mounted in isolation (no
 *    Request_Context_Bundle present), so middleware stay independent.
 */

const bundleMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: bundleMock };
  }),
}));

function makeBundle(overrides: Partial<PermissionBundle> = {}): PermissionBundle {
  return {
    admin: false,
    appAccess: true,
    tfaRequired: false,
    byKey: {},
    roles: [],
    policies: [],
    ...overrides,
  };
}

/**
 * A fake DB whose `.limit()`-terminated reads are drained from an ordered
 * queue and counted. The counter is what proves de-duplication: a request that
 * reuses the Request_Context_Bundle issues strictly fewer identity reads than
 * one that re-queries in each guard.
 */
function makeCountingDb(results: unknown[][]): { db: Database; reads: () => number } {
  const queue = [...results];
  let count = 0;
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => {
      count += 1;
      return Promise.resolve(queue.shift() ?? []);
    },
  };
  return {
    db: { select: () => fluent } as unknown as Database,
    reads: () => count,
  };
}

function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('studio')
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(new TextEncoder().encode('test-secret'));
}

// Runtime stub: the issuer cache returns `[]` so the external-JWT branch never
// touches the DB, keeping the read count attributable to the identity lookups.
const runtimeStub = {
  cache: { get: async () => [] as unknown, set: async () => undefined },
} as unknown as AppEnv['Variables']['runtime'];

function buildChainApp(db: Database, siteId: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('siteId', siteId);
    c.set('runtime', runtimeStub);
    await next();
  });
  app.use('*', withAuth());
  app.use('*', withSiteMembership());
  app.use('*', withStudioAccess());
  app.get('/api/v1/items/posts', (c) => c.json({ ok: true }));
  app.post('/api/v1/roles', (c) => c.json({ ok: true }, 201));
  return app;
}

const activeUser = {
  id: 'user-1',
  externalId: null,
  email: 'user@example.com',
  status: 'active',
  isBootstrap: false,
  tokenVersion: 0,
};

async function request(app: Hono<AppEnv>, path: string, token: string, method = 'GET') {
  return app.request(
    path,
    { method, headers: { Authorization: `Bearer ${token}` } },
    { JWT_SECRET: 'test-secret' },
  );
}

describe('Request_Context_Bundle — de-duplication across the guard chain', () => {
  beforeEach(() => {
    bundleMock.mockReset();
    bundleMock.mockResolvedValue(makeBundle());
  });

  it('resolves identity once: withSiteMembership adds no users/userSites reads', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' });
    // withAuth drains: apiKeys (miss), users (hit), userSites (membership).
    const { db, reads } = makeCountingDb([[], [activeUser], [{ roleId: 'member' }]]);
    const app = buildChainApp(db, 'site-a');

    const res = await request(app, '/api/v1/items/posts', token);

    expect(res.status).toBe(200);
    // Exactly the three withAuth reads — withSiteMembership reused the cached
    // principal instead of re-querying `users` + `userSites`.
    expect(reads()).toBe(3);
  });

  it('resolves the permission bundle once and reuses it in withStudioAccess', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' });
    const { db } = makeCountingDb([[], [activeUser], [{ roleId: 'member' }]]);
    const app = buildChainApp(db, 'site-a');

    // A Studio-management route (`/roles`) forces withStudioAccess to evaluate
    // the bundle; without reuse it would compute a second one.
    const res = await request(app, '/api/v1/roles', token, 'POST');

    expect(res.status).toBe(201);
    expect(bundleMock).toHaveBeenCalledTimes(1);
  });
});

describe('Request_Context_Bundle — guard semantics unchanged (principal × route → status)', () => {
  beforeEach(() => {
    bundleMock.mockReset();
    bundleMock.mockResolvedValue(makeBundle());
  });

  it('member user → content route → 200', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' });
    const { db } = makeCountingDb([[], [activeUser], [{ roleId: 'member' }]]);
    const res = await request(buildChainApp(db, 'site-a'), '/api/v1/items/posts', token);
    expect(res.status).toBe(200);
  });

  it('member user with appAccess → studio route → 201', async () => {
    bundleMock.mockResolvedValue(makeBundle({ appAccess: true }));
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' });
    const { db } = makeCountingDb([[], [activeUser], [{ roleId: 'member' }]]);
    const res = await request(buildChainApp(db, 'site-a'), '/api/v1/roles', token, 'POST');
    expect(res.status).toBe(201);
  });

  it('user without appAccess → studio route → 403 APP_ACCESS_DENIED', async () => {
    bundleMock.mockResolvedValue(makeBundle({ appAccess: false }));
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' });
    const { db } = makeCountingDb([[], [activeUser], [{ roleId: 'member' }]]);
    const res = await request(buildChainApp(db, 'site-a'), '/api/v1/roles', token, 'POST');
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(res.status).toBe(403);
    expect(body.errors[0]?.code).toBe('APP_ACCESS_DENIED');
  });

  it('non-member user → rejected at withAuth membership gate → 401', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' });
    // users hit, userSites miss → withAuth rejects before the chain continues.
    const { db } = makeCountingDb([[], [activeUser], []]);
    const res = await request(buildChainApp(db, 'site-a'), '/api/v1/items/posts', token);
    expect(res.status).toBe(401);
  });

  it('frontend-audience session → studio route → 403 (ADR-011 hard wall)', async () => {
    const frontendToken = await new SignJWT({ userId: 'user-1', email: 'user@example.com', siteId: 'site-a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('frontend')
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(new TextEncoder().encode('test-secret'));
    const { db } = makeCountingDb([[], [activeUser], [{ roleId: 'member' }]]);
    const res = await request(buildChainApp(db, 'site-a'), '/api/v1/roles', frontendToken, 'POST');
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(res.status).toBe(403);
    expect(body.errors[0]?.code).toBe('APP_ACCESS_DENIED');
  });
});

describe('Request_Context_Bundle — middleware stay independent when mounted alone', () => {
  beforeEach(() => {
    bundleMock.mockReset();
    bundleMock.mockResolvedValue(makeBundle());
  });

  it('withSiteMembership falls back to querying when no principal is cached', async () => {
    // No withAuth in the chain: the Request_Context_Bundle is absent, so the
    // guard must still resolve `users` + `userSites` on its own.
    const { db, reads } = makeCountingDb([
      [{ id: 'user-1', externalId: null, email: 'user@example.com', isBootstrap: false }],
      [{ userId: 'user-1' }],
    ]);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1', email: 'user@example.com', raw: {} });
      c.set('siteId', 'site-a');
      c.set('db', db);
      c.set('runtime', runtimeStub);
      await next();
    });
    app.use('*', withSiteMembership());
    app.get('/api/v1/items/posts', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/items/posts');

    expect(res.status).toBe(200);
    // Two identity reads because there was no cache to reuse.
    expect(reads()).toBe(2);
  });
});
