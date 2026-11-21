import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, items, pages, roles, sites, users, userSites, type Database } from '@lumibase/database';
import { selectPageSections } from '@lumibase/contracts';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { deliverRouter } from '../deliver';
import { pagesRouter } from '../pages';

/**
 * Page composer backend (epic #667, V06 #684) against Postgres.
 *
 * - `GET /pages/blocks` lists only registered page blocks (`meta.pageBlock`).
 * - A composer layout (`version: 1`) is validated on write: registered
 *   blocks only, block data against the block's fields (incl. nested
 *   `blocks` fields), regions, published-only sources, no sensitive fields.
 * - Free-form layouts (no `version`) are stored untouched.
 * - `GET /deliver/page/:site/:slug` is unchanged and returns the composer's
 *   region/locale metadata inside `styleConfig`.
 */

const SITE = 'site_pages_composer_it';
const OTHER = 'site_pages_composer_other_it';
/**
 * The writer is a site administrator: section `source`s are only accepted from
 * a writer who can read the bound collection in full (SOURCE_FORBIDDEN, covered
 * by pages-source-access). This suite is about layout validation, not access.
 */
const ADMIN = 'usr_pages_composer_admin';

type Errors = { errors: Array<{ code: string; message: string; field?: string }> };

describe.skipIf(!hasDbIntegrationUrl)('page composer (DB integration)', () => {
  let db: Database;

  function app(siteId = SITE) {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = {};
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', { userId: ADMIN, email: `${ADMIN}@x.dev`, roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
      c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/pages', pagesRouter);
    a.route('/api/v1/deliver', deliverRouter);
    return a;
  }

  const send = (method: string, path: string, body?: unknown, siteId = SITE) =>
    app(siteId).request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  async function collection(siteId: string, name: string, meta: Record<string, unknown>, defs: Array<Record<string, unknown>>) {
    const [row] = await db.insert(collections).values({ siteId, name, meta }).returning({ id: collections.id });
    if (defs.length > 0) {
      await db.insert(fields).values(
        defs.map((d) => ({ siteId, collectionId: row!.id, interface: 'input', ...d }) as typeof fields.$inferInsert),
      );
    }
    return row!.id;
  }

  beforeAll(async () => {
    db = await connectDbIntegration('pages-composer');
  });

  afterAll(async () => {
    if (!db) return;
    for (const s of [SITE, OTHER]) await db.delete(sites).where(eq(sites.id, s)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    for (const s of [SITE, OTHER]) {
      await db.delete(sites).where(eq(sites.id, s));
      await db
        .insert(sites)
        .values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: s, name: s });
    }
    await db.insert(users).values({ id: ADMIN, email: 'pages-composer-admin@x.dev', status: 'active' }).onConflictDoNothing();
    for (const s of [SITE, OTHER]) {
      const [role] = await db
        .insert(roles)
        .values({ siteId: s, name: 'Admin', adminAccess: true, appAccess: true })
        .returning({ id: roles.id });
      await db.insert(userSites).values({ userId: ADMIN, siteId: s, roleId: role!.id });
    }
    await collection(SITE, 'hero', { pageBlock: true }, [
      { name: 'title', type: 'string', required: true },
      { name: 'cta', type: 'string' },
    ]);
    await collection(SITE, 'card', {}, [{ name: 'label', type: 'string', required: true }]);
    await collection(SITE, 'grid', { pageBlock: true }, [
      { name: 'heading', type: 'string' },
      { name: 'cards', type: 'blocks', interface: 'blocks', options: { allowedBlocks: ['card'] } },
    ]);
    await collection(SITE, 'secret_block', { pageBlock: true }, [
      { name: 'note', type: 'string', encrypted: true },
      { name: 'title', type: 'string' },
    ]);
    const posts = await collection(SITE, 'posts', {}, [{ name: 'title', type: 'string' }]);
    await db.insert(items).values([
      { siteId: SITE, collectionId: posts, status: 'published', data: { title: 'Live post' } },
      { siteId: SITE, collectionId: posts, status: 'draft', data: { title: 'Draft post' } },
    ]);
    // Same block name on another site: must not leak into this site's palette.
    await collection(OTHER, 'promo', { pageBlock: true }, [{ name: 'x', type: 'string' }]);
  });

  const layout = (sections: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1,
    regions: [{ key: 'main' }, { key: 'sidebar', label: 'Sidebar' }],
    sections,
    ...extra,
  });

  it('lists only this site’s registered page blocks, without sensitive fields', async () => {
    const res = await send('GET', '/api/v1/pages/blocks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; fields: Array<{ name: string }> }> };
    expect(body.data.map((b) => b.name)).toEqual(['grid', 'hero', 'secret_block']);
    expect(body.data.find((b) => b.name === 'secret_block')!.fields.map((f) => f.name)).toEqual(['title']);
  });

  it('accepts a valid composer layout and delivery returns it unchanged, regions and locales in styleConfig', async () => {
    const res = await send('POST', '/api/v1/pages', {
      slug: 'home',
      title: 'Home',
      layoutConfig: layout([
        { id: 's1', component: 'hero', data: { title: 'Welcome' }, styleConfig: { region: 'main' } },
        {
          id: 's2',
          component: 'grid',
          data: { heading: 'Cards', cards: [{ id: 'c1', type: 'card', data: { label: 'One' } }] },
          styleConfig: { region: 'sidebar', locales: ['vi'] },
          source: { collection: 'posts', limit: 5 },
        },
      ]),
    });
    expect(res.status).toBe(201);

    const delivered = await send('GET', `/api/v1/deliver/page/${SITE}/home`);
    expect(delivered.status).toBe(200);
    const payload = (await delivered.json()) as {
      sections: Array<{ id: string; component: string; styleConfig: Record<string, unknown>; data: Record<string, unknown> }>;
    };
    expect(payload.sections.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(payload.sections[1]!.styleConfig).toEqual({ region: 'sidebar', locales: ['vi'] });
    // Published items only; delivery flattens item data onto each row.
    const sourced = payload.sections[1]!.data.items as Array<{ title: string }>;
    expect(sourced.map((i) => i.title)).toEqual(['Live post']);
    // The frontend helper picks a region and drops sections hidden in a locale.
    expect(selectPageSections(payload.sections, { region: 'sidebar', locale: 'en' })).toEqual([]);
    expect(selectPageSections(payload.sections, { region: 'sidebar', locale: 'vi' }).map((s) => s.id)).toEqual(['s2']);
    expect(selectPageSections(payload.sections).map((s) => s.id)).toEqual(['s1']);
  });

  it('rejects unregistered blocks, invalid block data, nested block errors and unknown regions with field paths', async () => {
    const res = await send('POST', '/api/v1/pages', {
      slug: 'bad',
      title: 'Bad',
      layoutConfig: layout([
        { id: 'a', component: 'posts', data: {} },
        { id: 'b', component: 'hero', data: { cta: 'x' } },
        { id: 'c', component: 'grid', data: { cards: [{ id: 'c1', type: 'card', data: {} }] } },
        { id: 'd', component: 'hero', data: { title: 'ok', bogus: 1 } },
      ]),
    });
    expect(res.status).toBe(400);
    const fieldsWithErrors = ((await res.json()) as Errors).errors.map((e) => `${e.code}:${e.field}`);
    expect(fieldsWithErrors).toContain('UNKNOWN_BLOCK:sections.0.component');
    expect(fieldsWithErrors.some((f) => f.endsWith(':sections.1.data.title'))).toBe(true);
    expect(fieldsWithErrors.some((f) => f.includes('sections.2.data.cards.0.data.label'))).toBe(true);
    expect(fieldsWithErrors).toContain('UNKNOWN_FIELD:sections.3.data.bogus');

    const region = await send('POST', '/api/v1/pages', {
      slug: 'bad-region',
      title: 'Bad region',
      layoutConfig: layout([{ id: 'a', component: 'hero', data: { title: 'x' }, styleConfig: { region: 'footer' } }]),
    });
    expect(region.status).toBe(400);
    expect(((await region.json()) as Errors).errors[0]!.field).toBe('sections.0.styleConfig.region');
    expect(await db.select().from(pages).where(eq(pages.siteId, SITE))).toHaveLength(0);
  });

  it('refuses draft sources, sensitive block fields, foreign blocks and unknown source collections', async () => {
    const draft = await send('POST', '/api/v1/pages', {
      slug: 'drafts',
      title: 'Drafts',
      layoutConfig: layout([{ id: 'a', component: 'hero', data: { title: 'x' }, source: { collection: 'posts', status: 'draft' } }]),
    });
    expect(draft.status).toBe(400);

    const secret = await send('POST', '/api/v1/pages', {
      slug: 'secret',
      title: 'Secret',
      layoutConfig: layout([{ id: 'a', component: 'secret_block', data: { note: 'ssn', title: 't' } }]),
    });
    expect(secret.status).toBe(400);
    expect(((await secret.json()) as Errors).errors.map((e) => e.code)).toContain('SENSITIVE_FIELD');

    const foreign = await send('POST', '/api/v1/pages', {
      slug: 'foreign',
      title: 'Foreign',
      layoutConfig: layout([{ id: 'a', component: 'promo', data: { x: 'y' } }]),
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as Errors).errors[0]!.code).toBe('UNKNOWN_BLOCK');

    const missing = await send('POST', '/api/v1/pages', {
      slug: 'missing',
      title: 'Missing',
      layoutConfig: layout([{ id: 'a', component: 'hero', data: { title: 'x' }, source: { collection: 'nope' } }]),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as Errors).errors[0]!.code).toBe('UNKNOWN_COLLECTION');
  });

  it('validates on PATCH too, and leaves free-form (pre-composer) layouts untouched', async () => {
    // A free-form layout may not ask for drafts either (#1006)…
    const asksForDrafts = { sections: [{ id: 'x', component: 'AnythingGoes', source: { collection: 'posts', status: 'draft' } }] };
    const refused = await send('POST', '/api/v1/pages', { slug: 'legacy', title: 'Legacy', layoutConfig: asksForDrafts });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain('sections.0.source.status');

    // …but is otherwise stored untouched.
    const legacy = { sections: [{ id: 'x', component: 'AnythingGoes', data: { foo: 1 }, source: { collection: 'posts', limit: 3 } }] };
    const created = await send('POST', '/api/v1/pages', { slug: 'legacy', title: 'Legacy', layoutConfig: legacy });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const [row] = await db.select().from(pages).where(and(eq(pages.siteId, SITE), eq(pages.id, id)));
    expect(row?.layoutConfig).toEqual(legacy);

    const patched = await send('PATCH', `/api/v1/pages/${id}`, {
      layoutConfig: layout([{ id: 'a', component: 'hero', data: {} }]),
    });
    expect(patched.status).toBe(400);
    const ok = await send('PATCH', `/api/v1/pages/${id}`, {
      layoutConfig: layout([{ id: 'a', component: 'hero', data: { title: 'Now composed' } }]),
    });
    expect(ok.status).toBe(200);
    const stored = ((await ok.json()) as { data: { layoutConfig: { version: number; sections: Array<{ styleConfig: unknown }> } } }).data
      .layoutConfig;
    expect(stored.version).toBe(1);
    // Defaults are written explicitly so delivery returns the same shape.
    expect(stored.sections[0]!.styleConfig).toEqual({});
  });
});
