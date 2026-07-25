import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { collections, permissions, policies, roles } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { PermissionService } from '../../services/permission-service';
import { accessGrantsRouter } from '../access-grants';

/**
 * Route-level contract for the non-staff permission picker. The realm limits
 * themselves are covered in `services/auth/__tests__/realm-access.test.ts`;
 * this file pins how they surface over HTTP and that the picker payload the
 * Studio UI consumes stays stable.
 */

interface Captured {
  table: unknown;
  values?: Record<string, unknown>;
}

/**
 * `publicRoleExists` drives whether the site has public access on;
 * `permissionRows` is what a grant listing resolves to.
 */
function stubDb(captured: Captured[], opts: {
  publicRoleExists?: boolean;
  permissionRows?: unknown[];
} = {}) {
  const collectionRows = [
    { name: 'articles', label: 'Articles' },
    { name: 'pages', label: 'Pages' },
  ];

  return {
    insert(table: unknown) {
      const rec: Captured = { table };
      captured.push(rec);
      const chain: any = {
        values(v: Record<string, unknown>) {
          rec.values = v;
          return chain;
        },
        onConflictDoNothing: () => chain,
        onConflictDoUpdate: () => Promise.resolve(undefined),
        returning() {
          if (table === roles) return Promise.resolve([{ id: 'role_x' }]);
          if (table === policies) return Promise.resolve([{ id: 'policy_x' }]);
          return Promise.resolve([]);
        },
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
    select(_projection?: unknown) {
      let table: unknown;
      const chain: any = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(collectionRows),
        limit() {
          if (table === roles) {
            return Promise.resolve(opts.publicRoleExists ? [{ id: 'role_public' }] : []);
          }
          if (table === policies) return Promise.resolve([{ id: 'policy_x' }]);
          return Promise.resolve([]);
        },
        then(resolve: (v: unknown) => void) {
          if (table === collections) return resolve(collectionRows);
          if (table === permissions) return resolve(opts.permissionRows ?? []);
          resolve([]);
        },
      };
      return chain;
    },
    delete() {
      const chain: any = {
        where: () => chain,
        returning: () => Promise.resolve([{ id: 'perm_x' }]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
  } as never;
}

function buildApp(dbOpts: Parameters<typeof stubDb>[1] = {}): {
  app: Hono<AppEnv>;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const store = new Map<string, string>();
  const cache = {
    async get<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async increment() {
      return 1;
    },
  };

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', stubDb(captured, dbOpts));
    c.set('siteId', 'site_1');
    c.set('runtime', { cache } as never);
    c.set('auth', { userId: 'u1', email: 'admin@example.test', roles: [], raw: {} });
    await next();
  });
  app.route('/', accessGrantsRouter);
  return { app, captured };
}

/** `requireSiteAdmin` resolves admin through the permission bundle. */
function grantAdmin(): void {
  vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({
    admin: true,
    appAccess: true,
    tfaRequired: false,
    byKey: {},
    roles: [],
    policies: [],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /grants', () => {
  it('returns grantable collections and both realm descriptors', async () => {
    grantAdmin();
    const { app } = buildApp({ publicRoleExists: false });

    const res = await app.request('/grants', {}, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.data.collections).toEqual([
      { name: 'articles', label: 'Articles' },
      { name: 'pages', label: 'Pages' },
    ]);

    const [pub, sub] = body.data.realms;
    expect(pub).toMatchObject({
      key: 'public',
      allowedActions: ['read'],
      supportsOwnOnly: false,
      togglable: true,
      enabled: false,
    });
    expect(sub).toMatchObject({
      key: 'subscriber',
      allowedActions: ['read', 'create', 'update', 'delete'],
      supportsOwnOnly: true,
      togglable: false,
      enabled: true,
    });
  });

  it('reports public access as enabled once the role exists', async () => {
    grantAdmin();
    const { app } = buildApp({ publicRoleExists: true });
    const body = (await (await app.request('/grants', {}, {})).json()) as any;
    expect(body.data.realms[0].enabled).toBe(true);
  });

  it('is admin-gated', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({
      admin: false,
      appAccess: true,
      tfaRequired: false,
      byKey: {},
      roles: [],
      policies: [],
    });
    const { app } = buildApp();
    expect((await app.request('/grants', {}, {})).status).toBe(403);
  });
});

describe('POST /grants/:realm', () => {
  it('grants public read', async () => {
    grantAdmin();
    const { app, captured } = buildApp();

    const res = await app.request(
      '/grants/public',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: 'articles' }),
      },
      {},
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { collection: 'articles', action: 'read', publishedOnly: true, ownOnly: false },
    });
    expect(captured.some((c) => c.table === permissions)).toBe(true);
  });

  it.each(['create', 'update', 'delete'])(
    'refuses public %s with ACTION_NOT_ALLOWED',
    async (action) => {
      grantAdmin();
      const { app, captured } = buildApp();

      const res = await app.request(
        '/grants/public',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collection: 'articles', action }),
        },
        {},
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        errors: [{ code: 'ACTION_NOT_ALLOWED' }],
      });
      // Nothing was written.
      expect(captured.some((c) => c.table === permissions)).toBe(false);
    },
  );

  it('refuses an own-rows scope on the public realm', async () => {
    grantAdmin();
    const { app } = buildApp();

    const res = await app.request(
      '/grants/public',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: 'articles', ownOnly: true }),
      },
      {},
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      errors: [{ code: 'ROW_SCOPE_NOT_SUPPORTED' }],
    });
  });

  it('grants a scoped subscriber write', async () => {
    grantAdmin();
    const { app } = buildApp();

    const res = await app.request(
      '/grants/subscriber',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: 'comments', action: 'update', ownOnly: true }),
      },
      {},
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { collection: 'comments', action: 'update', ownOnly: true, publishedOnly: false },
    });
  });

  it('404s an unknown realm', async () => {
    grantAdmin();
    const { app } = buildApp();
    const res = await app.request(
      '/grants/staff',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: 'articles' }),
      },
      {},
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ errors: [{ code: 'UNKNOWN_REALM' }] });
  });
});

describe('enable / disable', () => {
  it('enables the public realm', async () => {
    grantAdmin();
    const { app, captured } = buildApp();

    const res = await app.request('/grants/public/enable', { method: 'POST' }, {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { enabled: true } });
    expect(captured.some((c) => c.table === roles)).toBe(true);
  });

  it('disables the public realm', async () => {
    grantAdmin();
    const { app } = buildApp({ publicRoleExists: true });

    const res = await app.request('/grants/public/disable', { method: 'POST' }, {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { enabled: false } });
  });

  it('refuses to toggle the subscriber realm', async () => {
    grantAdmin();
    const { app } = buildApp();

    const res = await app.request('/grants/subscriber/enable', { method: 'POST' }, {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      errors: [{ code: 'REALM_NOT_TOGGLABLE' }],
    });
  });
});

describe('DELETE /grants/:realm/:collection/:action', () => {
  it('revokes a grant', async () => {
    grantAdmin();
    const { app } = buildApp();
    const res = await app.request('/grants/public/articles/read', { method: 'DELETE' }, {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { realm: 'public', collection: 'articles', action: 'read', removed: true },
    });
  });

  it('rejects an unknown action', async () => {
    grantAdmin();
    const { app } = buildApp();
    const res = await app.request('/grants/public/articles/publish', { method: 'DELETE' }, {});
    expect(res.status).toBe(400);
  });
});
