import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { collections, items, pages, sites, type Database } from '@lumibase/database';
import { MemoryCacheProvider, type EdgeCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

vi.mock('../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => true,
}));

const { deliverRouter } = await import('../routes/deliver');
const { personalisationRouter } = await import('../modules/personalisation/routes');

/**
 * Personalisation end to end on real PostgreSQL (#762): audiences and
 * variants through the admin API, delivery picking the variant per request,
 * one cached copy per audience at every tier, consent gating, exposures, and
 * invalidation when a variant changes.
 */

const SITE = 'site_perso_a';
const PLAIN_SITE = 'site_perso_b';

/** URL-keyed edge cache double (the Workers cache keys by URL only). */
function edge(): EdgeCacheProvider & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      const hit = store.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res.clone());
    },
    async purge(opts: { urls?: string[]; tags?: string[] }) {
      for (const u of opts.urls ?? []) store.delete(u);
      return (opts.urls ?? []).length;
    },
  } as EdgeCacheProvider & { store: Map<string, Response> };
}

describe.skipIf(!hasDbIntegrationUrl)('personalisation (real PostgreSQL)', () => {
  let db: Database;
  const cache = new MemoryCacheProvider();
  const edgeCache = edge();
  let itemId = '';
  let pageId = '';

  const app = () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db as never);
      c.set('siteId', SITE);
      c.set('auth', { userId: 'admin_1', roles: ['admin'], raw: {} } as AppEnv['Variables']['auth']);
      c.set('runtime', { cache, edgeCache } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/deliver', deliverRouter);
    a.route('/api/v1/personalisation', personalisationRouter);
    return a;
  };
  const admin = (path: string, method: string, body?: unknown) =>
    app().request(`/api/v1/personalisation${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const deliver = (site: string, headers: Record<string, string> = {}, query = '') =>
    app().request(`https://cms.example/api/v1/deliver/page/${site}/home${query}`, { headers });
  type Payload = {
    page: { title: string };
    sections: Array<{ data: { items: Array<{ title: string }> } }>;
    personalisation?: { audience: string | null; variants: string[] };
  };

  beforeAll(async () => {
    db = await connectDbIntegration('personalisation');
    for (const site of [SITE, PLAIN_SITE]) {
      await db.delete(sites).where(eq(sites.id, site));
      await db.insert(sites).values({
        organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
        id: site,
        name: site,
      });
      const [col] = await db.insert(collections).values({ siteId: site, name: 'posts' }).returning();
      const [it] = await db
        .insert(items)
        .values({ siteId: site, collectionId: col!.id, status: 'published', data: { title: 'Hello', body: 'Default body' } })
        .returning();
      const [pg] = await db
        .insert(pages)
        .values({ siteId: site, slug: 'home', title: 'Home', layoutConfig: { sections: [{ id: 's1', component: 'list', source: { collection: 'posts' } }] } })
        .returning();
      if (site === SITE) {
        itemId = it!.id;
        pageId = pg!.id;
      }
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const site of [SITE, PLAIN_SITE]) await db.delete(sites).where(eq(sites.id, site)).catch(() => undefined);
  });

  let vnId = '';
  let goldId = '';
  let goldItemVariant = '';

  it('admin API: validates and stores audiences and variants', async () => {
    const bad = await admin('/audiences', 'POST', { key: 'Bad Key', name: 'x', rules: { conditions: [{ attribute: 'country', op: 'eq', value: 'VN' }] } });
    expect(bad.status).toBe(400);
    const vn = await admin('/audiences', 'POST', { key: 'vn', name: 'Vietnam', priority: 20, rules: { conditions: [{ attribute: 'country', op: 'eq', value: 'VN' }] } });
    expect(vn.status).toBe(201);
    expect((await vn.json()) as { data: { needsConsent: boolean } }).toMatchObject({ data: { needsConsent: false } });
    vnId = ((await (await admin('/audiences', 'GET')).json()) as { data: Array<{ id: string }> }).data[0]!.id;
    const gold = await admin('/audiences', 'POST', { key: 'gold', name: 'Gold members', priority: 10, rules: { conditions: [{ attribute: 'attr.tier', op: 'eq', value: 'gold' }] } });
    goldId = ((await gold.json()) as { data: { id: string; needsConsent: boolean } }).data.id;
    expect((await admin('/audiences', 'POST', { key: 'vn', name: 'dup', rules: { conditions: [{ attribute: 'locale', op: 'eq', value: 'vi' }] } })).status).toBe(409);

    expect((await admin('/variants', 'POST', { subjectType: 'page', subjectId: pageId, audienceId: vnId, overrides: { title: 'Xin chào' }, status: 'published' })).status).toBe(201);
    const goldItem = await admin('/variants', 'POST', { subjectType: 'item', subjectId: itemId, audienceId: goldId, overrides: { title: 'Gold hello' }, status: 'published' });
    goldItemVariant = ((await goldItem.json()) as { data: { id: string } }).data.id;
    // A draft variant is never delivered.
    expect((await admin('/variants', 'POST', { subjectType: 'item', subjectId: itemId, audienceId: vnId, overrides: { body: 'Draft' } })).status).toBe(201);

    expect((await admin('/variants', 'POST', { subjectType: 'item', subjectId: itemId, audienceId: goldId, overrides: { title: 'again' } })).status).toBe(409);
    expect((await admin('/variants', 'POST', { subjectType: 'item', subjectId: itemId, audienceId: vnId, overrides: { status: 'draft' } })).status).toBe(400);
    expect((await admin('/variants', 'POST', { subjectType: 'item', subjectId: 'nope', audienceId: goldId, overrides: { title: 'x' } })).status).toBe(404);
    expect((await admin('/variants', 'POST', { subjectType: 'page', subjectId: pageId, audienceId: 'nope', overrides: { title: 'x' } })).status).toBe(404);
  });

  it('delivers the variant of the resolved audience, keyed per audience at every cache tier', async () => {
    const plain = await deliver(SITE);
    const plainBody = (await plain.json()) as Payload;
    expect(plain.headers.get('x-lumi-variant')).toBe('_');
    expect(plain.headers.get('vary')).toContain('CF-IPCountry');
    expect(plain.headers.get('vary')).toContain('X-Lumi-Attrs');
    expect(plainBody).toMatchObject({ page: { title: 'Home' }, personalisation: { audience: null, variants: [] } });
    expect(plainBody.sections[0]!.data.items[0]!.title).toBe('Hello');

    const vn = await deliver(SITE, { 'CF-IPCountry': 'VN' });
    const vnBody = (await vn.json()) as Payload;
    expect(vn.headers.get('x-lumi-variant')).toBe('vn');
    expect(vnBody.page.title).toBe('Xin chào');
    expect(vnBody.sections[0]!.data.items[0]).toMatchObject({ title: 'Hello', body: 'Default body' }); // the vn item variant is a draft

    // The tier rule needs personalisation consent: without it, VN wins.
    const noConsent = await deliver(SITE, { 'CF-IPCountry': 'VN', 'X-Lumi-Attrs': 'tier=gold' });
    expect(noConsent.headers.get('x-lumi-variant')).toBe('vn');
    const gold = await deliver(SITE, { 'CF-IPCountry': 'VN', 'X-Lumi-Attrs': 'tier=gold', 'X-Lumi-Consent': 'personalization' });
    const goldBody = (await gold.json()) as Payload;
    expect(gold.headers.get('x-lumi-variant')).toBe('gold');
    expect(goldBody.page.title).toBe('Home');
    expect(goldBody.sections[0]!.data.items[0]).toMatchObject({ title: 'Gold hello', body: 'Default body', id: itemId });
    expect(goldBody.personalisation).toEqual({ audience: 'gold', variants: [goldItemVariant] });

    expect(new Set([plain, vn, gold].map((r) => r.headers.get('etag'))).size).toBe(3);
    const edgeKeys = [...edgeCache.store.keys()].map((u) => new URL(u).searchParams.get('__aud')).sort();
    expect(edgeKeys).toEqual(['_', 'gold', 'vn']);

    // Same audience, different raw attributes → the same edge copy.
    const vnAgain = await deliver(SITE, { 'CF-IPCountry': 'VN', 'X-Lumi-Attrs': 'tier=silver', 'X-Lumi-Consent': 'personalization' });
    expect(((await vnAgain.json()) as Payload).page.title).toBe('Xin chào');
    expect(edgeCache.store.size).toBe(3);
    // A 304 for one audience never answers another.
    const cond = await deliver(SITE, { 'If-None-Match': vn.headers.get('etag')! });
    expect(cond.status).toBe(200);
  });

  it('records exposures only with analytics consent', async () => {
    const before = ((await (await admin('/exposures', 'GET')).json()) as { meta: { totals: Record<string, number> } }).meta.totals;
    await deliver(SITE, { 'CF-IPCountry': 'VN' });
    await deliver(SITE, { 'CF-IPCountry': 'VN', 'X-Lumi-Consent': 'analytics' });
    await deliver(SITE, { 'CF-IPCountry': 'VN', 'X-Lumi-Consent': 'analytics', 'Sec-GPC': '1' });
    await deliver(SITE, { 'X-Lumi-Consent': 'analytics' });
    await vi.waitFor(async () => {
      const res = (await (await admin('/exposures', 'GET')).json()) as {
        data: Array<{ subjectId: string; audienceKey: string; count: number }>;
        meta: { totals: Record<string, number> };
      };
      expect((res.meta.totals.vn ?? 0) - (before.vn ?? 0)).toBe(1);
      expect((res.meta.totals._ ?? 0) - (before._ ?? 0)).toBe(1);
      expect(res.data.every((r) => r.subjectId === 'home')).toBe(true);
    });
    expect((await admin('/exposures?from=2026-01-01&to=2028-01-01', 'GET')).status).toBe(400);
  });

  it('a variant change is live on the next request (caches invalidated)', async () => {
    const list = ((await (await admin(`/variants?subjectType=page&subjectId=${pageId}`, 'GET')).json()) as { data: Array<{ id: string }> }).data;
    expect((await admin(`/variants/${list[0]!.id}`, 'PATCH', { status: 'draft' })).status).toBe(200);
    const vn = await deliver(SITE, { 'CF-IPCountry': 'VN' });
    expect(((await vn.json()) as Payload).page.title).toBe('Home');
    // Deleting the audience removes its variants and its edge copy.
    expect((await admin(`/audiences/${goldId}`, 'DELETE')).status).toBe(200);
    const gold = await deliver(SITE, { 'X-Lumi-Attrs': 'tier=gold', 'X-Lumi-Consent': 'personalization' });
    expect(gold.headers.get('x-lumi-variant')).toBe('_');
    expect(((await gold.json()) as Payload).sections[0]!.data.items[0]!.title).toBe('Hello');
  });

  it('a site without audiences is delivered exactly as before', async () => {
    const res = await deliver(PLAIN_SITE, { 'CF-IPCountry': 'VN', 'X-Lumi-Consent': 'analytics' });
    expect(res.headers.get('x-lumi-variant')).toBeNull();
    expect(res.headers.get('vary')).toBe('X-Lumi-Site, Host');
    const body = (await res.json()) as Payload;
    expect(body.personalisation).toBeUndefined();
    expect([...edgeCache.store.keys()].some((u) => u.includes(PLAIN_SITE) && u.includes('__aud'))).toBe(false);
  });
});
