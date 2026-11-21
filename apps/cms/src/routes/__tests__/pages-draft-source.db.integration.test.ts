import { MemoryCacheProvider, MemoryRateLimiter, type EdgeCacheProvider } from '@lumibase/runtime';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, items, pages, roles, sites, userSites, users, type Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { deliverRouter } from '../deliver';
import { pagesRouter } from '../pages';
import { previewAdminRouter } from '../preview';
import { PREVIEW_UNAUTHORIZED_BODY, previewDeliveryRouter } from '../preview-delivery';

/**
 * #1006 — a page section `source` must never put draft items on a public page,
 * whatever the layout shape (free-form / legacy layouts included).
 *
 * - Public delivery resolves published items only, also for pages that already
 *   store `source.status: 'draft'` (read-time guard, no backfill), and also for
 *   anonymous `?preview=true` / `?draft=true` reads (those flags only skip caches).
 * - Page writes refuse a non-published `source.status` with a path-scoped 400.
 * - Drafts are visible through a signed preview token only
 *   (`GET /deliver/preview/:site/page/:slug`), never cached.
 * - Section sources never reach another site's items.
 */

const SITE_A = 'site_draft_src_a_it';
const SITE_B = 'site_draft_src_b_it';
const ADMIN = 'usr_draft_src_admin_it';
const SECRET = 'draft-source-integration-secret';

type Section = { id: string; data: { items?: Array<{ id: string; title?: string }> }; sourceError?: unknown };
type PageBody = { sections: Section[] };

/** URL-keyed edge cache double, like the Workers Cache API. */
function memoryEdgeCache(): EdgeCacheProvider & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async match(req) {
      const body = store.get(req.url);
      return body === undefined ? null : new Response(body, { headers: { 'content-type': 'application/json' } });
    },
    async put(req, res) {
      store.set(req.url, await res.clone().text());
    },
    async purge() {
      const n = store.size;
      store.clear();
      return n;
    },
  };
}

describe.skipIf(!hasDbIntegrationUrl)('page section sources never deliver drafts (#1006, DB integration)', () => {
  let db: Database;
  let appCache: MemoryCacheProvider;
  let edgeCache: ReturnType<typeof memoryEdgeCache>;
  let limiter: MemoryRateLimiter;

  function app(siteId: string, opts: { userId?: string; caches?: boolean } = {}) {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = { JWT_SECRET: SECRET };
      c.set('db', db);
      c.set('siteId', siteId);
      if (opts.userId) {
        c.set('auth', { userId: opts.userId, email: `${opts.userId}@x.dev`, roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
      }
      c.set('runtime', {
        cache: opts.caches ? appCache : undefined,
        edgeCache: opts.caches ? edgeCache : undefined,
        rateLimiter: limiter,
      } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/pages', pagesRouter);
    a.route('/api/v1/preview', previewAdminRouter);
    // Same order as the app: preview leaf paths before the public deliver router.
    a.route('/api/v1/deliver/preview', previewDeliveryRouter);
    a.route('/api/v1/deliver', deliverRouter);
    return a;
  }

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const layout = (...sources: Array<Record<string, unknown> | undefined>) => ({
    sections: sources.map((source, i) => ({ id: `s${i}`, component: 'list', ...(source ? { source } : {}) })),
  });
  const ids = (body: PageBody, section = 0) => (body.sections[section]!.data.items ?? []).map((i) => i.id).sort();

  let draftId: string;

  /** A page stored before #1006 (no write validation): inserted directly. */
  async function storeLegacyPage(siteId: string, slug: string, layoutConfig: Record<string, unknown>) {
    await db.insert(pages).values({ id: `pg_${siteId}_${slug}`, siteId, slug, title: slug, layoutConfig });
  }

  async function mintToken(body: Record<string, unknown>, siteId = SITE_A): Promise<string> {
    const res = await app(siteId, { userId: ADMIN }).request('/api/v1/preview/token', json('POST', body));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { token: string } }).data.token;
  }

  beforeAll(async () => {
    db = await connectDbIntegration('pages-draft-source');
  });

  afterAll(async () => {
    if (!db) return;
    for (const s of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, s)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    appCache = new MemoryCacheProvider();
    edgeCache = memoryEdgeCache();
    limiter = new MemoryRateLimiter();
    await db.insert(users).values({ id: ADMIN, email: 'draft-src-admin@x.dev', status: 'active' }).onConflictDoNothing();
    for (const s of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, s));
      await db
        .insert(sites)
        .values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: s, name: s });
      const role = (
        await db.insert(roles).values({ siteId: s, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id })
      )[0]!.id;
      await db.insert(userSites).values({ userId: ADMIN, siteId: s, roleId: role });
      // The same collection name on both sites: sources resolve by name.
      const posts = (await db.insert(collections).values({ siteId: s, name: 'posts' }).returning({ id: collections.id }))[0]!.id;
      await db.insert(fields).values({ siteId: s, collectionId: posts, name: 'title', type: 'string', interface: 'input' });
      await db.insert(items).values([
        { id: `${s}_pub`, siteId: s, collectionId: posts, status: 'published', data: { title: `${s} public` } },
        { id: `${s}_draft`, siteId: s, collectionId: posts, status: 'draft', data: { title: `${s} draft` } },
        { id: `${s}_archived`, siteId: s, collectionId: posts, status: 'archived', data: { title: `${s} archived` } },
      ]);
    }
    draftId = `${SITE_A}_draft`;
  });

  describe('public delivery (read-time guard)', () => {
    it('serves published items only for a stored free-form layout that asks for drafts', async () => {
      await storeLegacyPage(SITE_A, 'legacy', layout({ collection: 'posts', status: 'draft' }, { collection: 'posts', status: 'archived' }));

      for (const query of ['', '?preview=true', '?draft=true']) {
        const res = await app(SITE_A).request(`/api/v1/deliver/page/${SITE_A}/legacy${query}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as PageBody;
        expect(ids(body, 0)).toEqual([`${SITE_A}_pub`]);
        expect(ids(body, 1)).toEqual([`${SITE_A}_pub`]);
        expect(JSON.stringify(body)).not.toContain(`${SITE_A}_draft`);
        expect(JSON.stringify(body)).not.toContain(`${SITE_A}_archived`);
      }
    });

    it('never reaches another site through a section source', async () => {
      await storeLegacyPage(SITE_A, 'home', layout({ collection: 'posts', status: 'draft' }));
      await storeLegacyPage(SITE_B, 'home', layout({ collection: 'posts' }));

      const a = (await (await app(SITE_A).request(`/api/v1/deliver/page/${SITE_A}/home`)).json()) as PageBody;
      const b = (await (await app(SITE_B).request(`/api/v1/deliver/page/${SITE_B}/home`)).json()) as PageBody;
      expect(ids(a)).toEqual([`${SITE_A}_pub`]);
      expect(ids(b)).toEqual([`${SITE_B}_pub`]);

      // Asking site A's delivery for site B's page path still serves site B's own
      // published items only (tenancy comes from the path, never the request).
      const crossed = (await (await app(SITE_A).request(`/api/v1/deliver/page/${SITE_B}/home`)).json()) as PageBody;
      expect(ids(crossed)).toEqual([`${SITE_B}_pub`]);
    });
  });

  describe('page writes', () => {
    it('refuses a non-published source status with a path-scoped error, on create and patch', async () => {
      const admin = app(SITE_A, { userId: ADMIN });
      const refused = await admin.request(
        '/api/v1/pages',
        json('POST', { slug: 'p1', title: 'P1', layoutConfig: layout({ collection: 'posts' }, { collection: 'posts', status: 'draft' }) }),
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        errors: [{ code: 'VALIDATION', message: expect.stringContaining('published'), field: 'sections.1.source.status' }],
      });

      const ok = await admin.request(
        '/api/v1/pages',
        json('POST', { slug: 'p1', title: 'P1', layoutConfig: layout({ collection: 'posts' }, { collection: 'posts', status: 'published' }) }),
      );
      expect(ok.status).toBe(201);
      const id = ((await ok.json()) as { data: { id: string } }).data.id;

      const patched = await admin.request(
        `/api/v1/pages/${id}`,
        json('PATCH', { layoutConfig: layout(undefined, { collection: 'posts', status: 'archived' }, { collection: 'posts', status: 7 }) }),
      );
      expect(patched.status).toBe(400);
      const errors = ((await patched.json()) as { errors: Array<{ field: string }> }).errors.map((e) => e.field);
      expect(errors).toEqual(['sections.1.source.status', 'sections.2.source.status']);

      // Nothing was stored by the refused writes.
      const [row] = await db.select().from(pages).where(eq(pages.id, id));
      expect(JSON.stringify(row?.layoutConfig)).not.toContain('archived');
    });

    it('lets a stored draft source be fixed by saving the layout without it', async () => {
      await storeLegacyPage(SITE_A, 'legacy', layout({ collection: 'posts', status: 'draft' }));
      const admin = app(SITE_A, { userId: ADMIN });
      const res = await admin.request(`/api/v1/pages/pg_${SITE_A}_legacy`, json('PATCH', { layoutConfig: layout({ collection: 'posts' }) }));
      expect(res.status).toBe(200);
      // A title-only patch does not re-validate the stored layout.
      await storeLegacyPage(SITE_A, 'other', layout({ collection: 'posts', status: 'draft' }));
      const title = await admin.request(`/api/v1/pages/pg_${SITE_A}_other`, json('PATCH', { title: 'Renamed' }));
      expect(title.status).toBe(200);
    });
  });

  describe('preview', () => {
    it('shows the previewed draft through a preview token, and only with one', async () => {
      await storeLegacyPage(SITE_A, 'home', layout({ collection: 'posts', status: 'draft', orderBy: 'title' }));
      const token = await mintToken({ collection: 'posts', itemId: draftId });

      const res = await app(SITE_A).request(`/api/v1/deliver/preview/${SITE_A}/page/home`, { headers: { 'x-lumibase-preview': token } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      const body = (await res.json()) as { data: PageBody & { page: { slug: string } } };
      expect(body.data.page.slug).toBe('home');
      // Live items + the token's target; never other drafts or archived items.
      expect(ids(body.data)).toEqual([`${SITE_A}_draft`, `${SITE_A}_pub`]);
      expect(body.data.sections[0]!.data.items!.map((i) => i.title)).toEqual([`${SITE_A} draft`, `${SITE_A} public`]);

      const anonymous = await app(SITE_A).request(`/api/v1/deliver/preview/${SITE_A}/page/home`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual(PREVIEW_UNAUTHORIZED_BODY);
    });

    it('rejects a site A token on site B pages', async () => {
      await storeLegacyPage(SITE_B, 'home', layout({ collection: 'posts' }));
      const token = await mintToken({ collection: 'posts', itemId: draftId });
      const res = await app(SITE_B).request(`/api/v1/deliver/preview/${SITE_B}/page/home`, { headers: { 'x-lumibase-preview': token } });
      expect(res.status).toBe(401);
    });
  });

  describe('caches', () => {
    it('never stores a draft under a public key, before or after a preview read', async () => {
      await storeLegacyPage(SITE_A, 'home', layout({ collection: 'posts', status: 'draft' }));
      const token = await mintToken({ collection: 'posts', itemId: draftId });
      const cached = app(SITE_A, { caches: true });

      const preview = await cached.request(`/api/v1/deliver/preview/${SITE_A}/page/home`, { headers: { 'x-lumibase-preview': token } });
      expect(ids(((await preview.json()) as { data: PageBody }).data)).toContain(draftId);
      expect(edgeCache.store.size).toBe(0);

      const first = (await (await cached.request(`/api/v1/deliver/page/${SITE_A}/home`)).json()) as PageBody;
      const again = (await (await cached.request(`/api/v1/deliver/page/${SITE_A}/home`)).json()) as PageBody;
      expect(ids(first)).toEqual([`${SITE_A}_pub`]);
      expect(ids(again)).toEqual([`${SITE_A}_pub`]);

      // Anonymous preview flags bypass the caches and still serve published only.
      const flagged = (await (await cached.request(`/api/v1/deliver/page/${SITE_A}/home?preview=true`)).json()) as PageBody;
      expect(ids(flagged)).toEqual([`${SITE_A}_pub`]);

      // Whatever the public route stored, under any key, holds no draft.
      expect(edgeCache.store.size).toBeGreaterThan(0);
      for (const body of edgeCache.store.values()) expect(body).not.toContain(draftId);
      expect(JSON.stringify([...edgeCache.store.keys()])).not.toContain('/deliver/preview/');
    });
  });
});
