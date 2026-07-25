import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { collections, createDb, fields, relations, roles, sites, userSites, users, type Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { itemsRouter } from '../items';

/**
 * Route-level DB-integration test (Req 2, 3, 5): preflight, the 409 block on
 * DELETE when a restrict relation has dependents, and re-delete after resolving.
 * Skips without DATABASE_URL.
 *
 * **Validates: Requirements 2 (preflight), 3 (409 DEPENDENT_RECORDS_EXIST), 5 (resolve then delete)**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_deps_route_it';
const ADMIN = 'usr_deps_route_admin';

describe('items dependents routes — DB integration', () => {
  let db: Database;
  let canConnect = false;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // buildService reads c.env (e.g. SITE_ROOM for realtime); give it an object.
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: ADMIN, email: 'a@x.dev', roles: ['admin'], raw: { dev: true } } as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping dependents-route DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping dependents-route DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  let articleId = '';
  let relId = '';

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Deps Route IT' });
    // The routes enforce real RBAC (dependents-service gates per-action): seed
    // an admin membership so the request principal has admin bypass.
    await db.insert(users).values({ id: ADMIN, email: 'deps-route-admin@x.dev', status: 'active' }).onConflictDoNothing();
    const adminRole = (
      await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id })
    )[0]!.id;
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole });
    const articlesId = (await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'A' }).returning({ id: collections.id }))[0]!.id;
    const commentsId = (await db.insert(collections).values({ siteId: SITE, name: 'comments', label: 'C' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: articlesId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: commentsId, name: 'article', type: 'string', interface: 'input' },
    ]);
    relId = (await db.insert(relations).values({ siteId: SITE, manyCollection: 'comments', manyField: 'article', oneCollection: 'articles', type: 'm2o', onDelete: 'restrict' }).returning({ id: relations.id }))[0]!.id;
    const item = new ItemService({ db, siteId: SITE });
    articleId = ((await item.create('articles', { data: { title: 'A' } })) as { id: string }).id;
    await item.create('comments', { data: { article: articleId } });
  });

  it('GET dependents returns a blocking report (Req 2)', async () => {
    if (!canConnect) return;
    const res = await app.request(`/api/v1/items/articles/${articleId}/dependents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { blocking: boolean; dependents: Array<{ count: number }> } };
    expect(body.data.blocking).toBe(true);
    expect(body.data.dependents[0]?.count).toBe(1);
  });

  it('DELETE returns 409 DEPENDENT_RECORDS_EXIST when blocked (Req 3)', async () => {
    if (!canConnect) return;
    const res = await app.request(`/api/v1/items/articles/${articleId}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('DEPENDENT_RECORDS_EXIST');
  });

  it('resolve (set_null) clears the dependents so the delete is no longer blocked (Req 5)', async () => {
    if (!canConnect) return;
    const resolve = await app.request(`/api/v1/items/articles/${articleId}/resolve-dependents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_null', relation: relId }),
    });
    expect(resolve.status).toBe(200);
    const body = (await resolve.json()) as { data: { affected: number } };
    expect(body.data.affected).toBe(1);
    // The preflight is now empty / non-blocking → a delete would proceed.
    const after = await app.request(`/api/v1/items/articles/${articleId}/dependents`);
    const report = (await after.json()) as { data: { blocking: boolean; dependents: unknown[] } };
    expect(report.data.blocking).toBe(false);
    expect(report.data.dependents).toHaveLength(0);
  });
});
