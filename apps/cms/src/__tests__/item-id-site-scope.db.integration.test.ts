import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { collections, contentReviews, items, revisions, roles, sites, userSites, users, type Database } from '@lumibase/database';
import type { AppEnv } from '../env';
import { itemsRouter } from '../routes/items';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Item ids are unique per site, not per instance (migration 0029).
 *
 * Before: `lumibase_items` had PRIMARY KEY (id) while ItemService only checked
 * the caller's site and collection, so a string id another site already used
 * hit the global key and the route answered 500 — and one site could take an id
 * another site could then never use.
 */

const SITE_A = 'site_itemid_a';
const SITE_B = 'site_itemid_b';
const ADMIN = 'usr_itemid_admin';

describe.skipIf(!hasDbIntegrationUrl)('item ids are scoped to their site', () => {
  let db: Database;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', c.req.header('x-site') === SITE_B ? SITE_B : SITE_A);
    c.set('auth', { userId: ADMIN, email: 'itemid@x.dev', roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  const post = (site: string, path: string, body: unknown) =>
    app.request(`/api/v1/items/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-site': site },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await connectDbIntegration('item-id-site-scope');
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, id)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.insert(users).values({ id: ADMIN, email: 'itemid-admin@x.dev', status: 'active' }).onConflictDoNothing();
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site));
      await db.insert(sites).values({
        organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
        id: site,
        name: site,
      });
      const role = (await db.insert(roles).values({ siteId: site, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id }))[0]!.id;
      await db.insert(userSites).values({ userId: ADMIN, siteId: site, roleId: role });
      await db.insert(collections).values([
        { siteId: site, name: 'pages', label: 'Pages', primaryKeyType: 'string' },
        { siteId: site, name: 'posts', label: 'Posts', primaryKeyType: 'string' },
      ]);
    }
  });

  // Only this test's sites: other suites may use the same ids elsewhere, which
  // is exactly what is now allowed.
  const mine = inArray(items.siteId, [SITE_A, SITE_B]);
  const itemRows = (id: string) => db.select({ siteId: items.siteId }).from(items).where(and(mine, eq(items.id, id)));

  it('two sites can each create an item with the same string id', async () => {
    const a = await post(SITE_A, 'pages', { data: { id: 'home' } });
    expect(a.status).toBe(201);
    const b = await post(SITE_B, 'pages', { data: { id: 'home' } });
    expect(b.status).toBe(201);
    expect((await itemRows('home')).map((r) => r.siteId).sort()).toEqual([SITE_A, SITE_B]);

    // Each item has its own revision, in its own site.
    const revs = await db.select({ siteId: revisions.siteId }).from(revisions)
      .where(and(inArray(revisions.siteId, [SITE_A, SITE_B]), eq(revisions.itemId, 'home')));
    expect(revs.map((r) => r.siteId).sort()).toEqual([SITE_A, SITE_B]);
  });

  it('the same id twice in one site is a clean 409, also across collections', async () => {
    expect((await post(SITE_A, 'pages', { data: { id: 'about' } })).status).toBe(201);

    const sameCollection = await post(SITE_A, 'pages', { data: { id: 'about' } });
    expect(sameCollection.status).toBe(409);
    expect(await sameCollection.json()).toMatchObject({ errors: [{ code: 'ITEM_ID_EXISTS' }] });

    const otherCollection = await post(SITE_A, 'posts', { data: { id: 'about' } });
    expect(otherCollection.status).toBe(409);
    expect(await otherCollection.json()).toMatchObject({ errors: [{ code: 'ITEM_ID_EXISTS' }] });
  });

  it('a bulk create that repeats an id is a 409, not a 500, and writes nothing', async () => {
    const res = await post(SITE_A, 'pages/bulk', { op: 'create', items: [{ id: 'dup' }, { id: 'dup' }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'ITEM_ID_EXISTS' }] });
    expect(await itemRows('dup')).toEqual([]);
  });

  it('referencing tables only point at an item of their own site', async () => {
    expect((await post(SITE_B, 'pages', { data: { id: 'only-b' } })).status).toBe(201);
    const collA = (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE_A), eq(collections.name, 'pages'))))[0]!;
    await expect(
      db.insert(revisions).values({ siteId: SITE_A, collectionId: collA.id, itemId: 'only-b', delta: {} }),
    ).rejects.toThrow();
  });

  it('deleting an item keeps its review history (item_id set to null, site kept)', async () => {
    expect((await post(SITE_A, 'pages', { data: { id: 'reviewed' } })).status).toBe(201);
    expect((await post(SITE_B, 'pages', { data: { id: 'reviewed' } })).status).toBe(201);
    await db.insert(contentReviews).values({ siteId: SITE_A, itemId: 'reviewed' });

    await db.delete(items).where(and(eq(items.siteId, SITE_A), eq(items.id, 'reviewed')));

    const [review] = await db.select().from(contentReviews).where(eq(contentReviews.siteId, SITE_A));
    expect(review).toMatchObject({ siteId: SITE_A, itemId: null });
    // Site B's item with the same id is untouched.
    expect((await itemRows('reviewed')).map((r) => r.siteId)).toEqual([SITE_B]);
  });
});
