import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { collections, createDb, fields, revisions, roles, sites, userSites, users, type Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { itemsRouter } from '../items';

/**
 * Route-level tests for the content-versions endpoints (task 4.3): CRUD +
 * 409 duplicate key, compare, promote (writes a revision, removes the version,
 * reports `meta.mainDiverged`), and 403 for a principal without grants.
 * Skips without DATABASE_URL (runs in CI).
 *
 * **Validates: content-versioning Requirements 1, 2, 3 (HTTP layer)**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_ver_route_it';
const ADMIN = 'usr_ver_route_admin';
const VIEWER = 'usr_ver_route_viewer';

type AuthVar = AppEnv['Variables']['auth'];

describe('items versions routes — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let currentAuth: AuthVar;

  const adminAuth = { userId: ADMIN, email: 'ver-admin@x.dev', roles: ['admin'], raw: { dev: true } } as AuthVar;
  const viewerAuth = { userId: VIEWER, email: 'ver-viewer@x.dev', roles: [], raw: { dev: true } } as AuthVar;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', currentAuth);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping versions-route DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping versions-route DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, VIEWER)).catch(() => undefined);
  });

  let itemId = '';

  beforeEach(async () => {
    if (!canConnect) return;
    currentAuth = adminAuth;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Versions Route IT' });
    // Admin with bypass; viewer is a member with a no-grant role (RBAC denies).
    await db
      .insert(users)
      .values([
        { id: ADMIN, email: 'ver-admin@x.dev', status: 'active' },
        { id: VIEWER, email: 'ver-viewer@x.dev', status: 'active' },
      ])
      .onConflictDoNothing();
    const [adminRole, memberRole] = await db
      .insert(roles)
      .values([
        { siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true },
        { siteId: SITE, name: 'Member', adminAccess: false, appAccess: true },
      ])
      .returning({ id: roles.id });
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: adminRole!.id },
      { userId: VIEWER, siteId: SITE, roleId: memberRole!.id },
    ]);

    const collId = (
      await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
    ]);
    const created = await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'main' } });
    itemId = (created as { id: string }).id;
  });

  const base = () => `/api/v1/items/articles/${itemId}/versions`;

  function post(path: string, body?: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  it('CRUD: create → list → get → patch → delete, 409 on a duplicate key (Req 1)', async () => {
    if (!canConnect) return;
    const created = await post(base(), { key: 'draft-a', name: 'Draft A' });
    expect(created.status).toBe(201);

    // Duplicate key → 409 VERSION_EXISTS.
    const dupe = await post(base(), { key: 'draft-a', name: 'Again' });
    expect(dupe.status).toBe(409);
    expect(((await dupe.json()) as { errors: Array<{ code: string }> }).errors[0]?.code).toBe('VERSION_EXISTS');

    const list = await app.request(base());
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ key: string; mainChanged: boolean }> };
    expect(listBody.data.map((v) => v.key)).toEqual(['draft-a']);
    expect(listBody.data[0]!.mainChanged).toBe(false); // snapshot === main

    const patched = await app.request(`${base()}/draft-a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', data: { title: 'branched' } }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: { name: string } }).data.name).toBe('Renamed');

    const del = await app.request(`${base()}/draft-a`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const gone = await app.request(`${base()}/draft-a`);
    expect(gone.status).toBe(404);
  });

  it('compare returns main, version data and field-level changes (Req 2)', async () => {
    if (!canConnect) return;
    await post(base(), { key: 'draft-b', name: 'Draft B' });
    await app.request(`${base()}/draft-b`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { title: 'branched' } }),
    });

    const res = await app.request(`${base()}/draft-b/compare`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { main: Record<string, unknown>; version: Record<string, unknown>; changes: Array<{ key: string; state: string }> };
    };
    expect(body.data.main.title).toBe('main');
    expect(body.data.version.title).toBe('branched');
    const titleChange = body.data.changes.find((ch) => ch.key === 'title');
    expect(titleChange?.state).toBe('changed');
  });

  it('promote applies the version via ItemService (revision written), removes it, reports meta.mainDiverged (Req 3)', async () => {
    if (!canConnect) return;
    await post(base(), { key: 'draft-c', name: 'Draft C' });
    await app.request(`${base()}/draft-c`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { title: 'promoted' } }),
    });
    // Diverge main AFTER the snapshot so mainDiverged is true.
    await new ItemService({ db, siteId: SITE }).patch('articles', itemId, { data: { title: 'main-moved' } });

    const before = await db
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.siteId, SITE), eq(revisions.itemId, itemId)));

    const res = await post(`${base()}/draft-c/promote`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { data: Record<string, unknown> }; meta: { mainDiverged: boolean } };
    expect(body.meta.mainDiverged).toBe(true);
    expect(body.data.data.title).toBe('promoted');

    // Promote wrote a revision (delegated through ItemService.patch)…
    const after = await db
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.siteId, SITE), eq(revisions.itemId, itemId)));
    expect(after.length).toBeGreaterThan(before.length);

    // …and the version is gone.
    expect((await app.request(`${base()}/draft-c`)).status).toBe(404);
  });

  it('403 for a member without grants (RBAC via ItemService, Req permission-gate)', async () => {
    if (!canConnect) return;
    currentAuth = viewerAuth;
    const res = await post(base(), { key: 'nope', name: 'Nope' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('FORBIDDEN');
  });
});
