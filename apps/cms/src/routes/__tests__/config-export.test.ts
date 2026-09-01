import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { CONFIG_MANIFEST_VERSION } from '@lumibase/contracts/schemas';
import { configRouter } from '../config';

/**
 * Route-wiring test for GET /api/v1/config/export (Phase B).
 *   Req 1.1 — endpoint returns { data: manifest } with the right version.
 *   Req 1.6 — scope filtering is honoured.
 *   Req 7.3 — admin guard rejects non-admin callers.
 *
 * Uses a fluent fake DB (mirrors access-import.test.ts) so it runs without a
 * database. The dev-admin auth shape takes the `requireSiteAdmin` dev escape
 * hatch (site-admin.ts:35), keeping the guard exercised without seeding roles.
 *
 * **Validates: Requirements 1.1, 1.6, 7.3**
 */

// Returns canned rows for the 5 sequential selects loadState() issues:
// collections, relations, webhooks, settings, then fields.
function fakeDb(): Database {
  const sequence: unknown[][] = [
    [{ id: 'col_1', siteId: 'site_1', name: 'articles', label: 'Articles', versioning: true }], // collections
    [], // relations
    [], // webhooks
    [{ id: 'set_1', siteId: 'site_1', key: 'login_security_policy', value: { x: 1 }, scope: 'site' }], // settings
    [{ id: 'fld_1', siteId: 'site_1', collectionId: 'col_1', name: 'title', type: 'string', interface: 'input' }], // fields
  ];
  let i = 0;
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    orderBy: () => Promise.resolve(sequence[i++] ?? []),
    then: (resolve: (v: unknown) => void, reject: (r?: unknown) => void) =>
      Promise.resolve(sequence[i++] ?? []).then(resolve, reject),
  };
  return { select: () => fluent } as unknown as Database;
}

function buildApp(opts: { admin: boolean }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb());
    c.set('siteId', 'site_1');
    c.set('auth', {
      roles: opts.admin ? ['admin'] : ['editor'],
      raw: { dev: true },
    } as AppEnv['Variables']['auth']);
    await next();
  });
  app.route('/api/v1/config', configRouter);
  return app;
}

describe('GET /api/v1/config/export', () => {
  it('returns a versioned manifest for an admin caller (Req 1.1)', async () => {
    const app = buildApp({ admin: true });
    const res = await app.request('/api/v1/config/export');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: string; collections: unknown[]; fields: unknown[]; settings: unknown[] } };
    expect(body.data.version).toBe(CONFIG_MANIFEST_VERSION);
    expect(body.data.collections).toHaveLength(1);
    expect(body.data.fields).toHaveLength(1);
    expect(body.data.settings).toHaveLength(1);
    // Field is keyed by collection name, not collectionId.
    expect((body.data.fields[0] as { collection: string }).collection).toBe('articles');
    // No id / siteId leaks (Req 1.3).
    expect(JSON.stringify(body.data)).not.toContain('col_1');
    expect(JSON.stringify(body.data)).not.toContain('site_1');
  });

  it('honours scope=settings (Req 1.6)', async () => {
    const app = buildApp({ admin: true });
    const res = await app.request('/api/v1/config/export?scope=settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { collections: unknown[]; settings: unknown[] } };
    expect(body.data.collections).toHaveLength(0);
    expect(body.data.settings).toHaveLength(1);
  });

  it('rejects a non-admin caller with 403 (Req 7.3)', async () => {
    const app = buildApp({ admin: false });
    const res = await app.request('/api/v1/config/export');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('FORBIDDEN');
  });
});
