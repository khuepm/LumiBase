import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { collections, files, items, relations, roles, sites, userSites, users, type Database } from '@lumibase/database';
import { isRichTextDocument, type RichTextDocument } from '@lumibase/contracts/richtext';
import type { AppEnv } from '../env';
import { collectionsRouter } from '../routes/collections';
import { relationsRouter } from '../routes/relations';
import { itemsRouter } from '../routes/items';
import { filesRouter } from '../routes/files';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
// The real CLI command, run in-process against the real routes (#728).
import { migrateCommand } from '../../../../packages/cli/src/commands/migrate';
import { parseArgs } from '../../../../packages/cli/src/utils/args';

/**
 * Acceptance for #728: a Contentful space with 5 content types migrates end to
 * end, in dry run and in apply, through `lumibase migrate contentful`. The
 * CLI's HTTP calls go to an in-process app with the collections, relations,
 * items and files routes on a real Postgres; only the asset CDN is stubbed.
 */

const SITE = 'site_migrate_cf_it';
const ADMIN = 'usr_migrate_cf_admin';
const FIXTURE = resolve(__dirname, '../../../../packages/cli/test/fixtures/contentful-space.json');
const ASSET_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe.skipIf(!hasDbIntegrationUrl)('lumibase migrate contentful — end to end', () => {
  let db: Database;
  let cwd: string;
  const stored = new Map<string, number>();
  const cdnHits: string[] = [];

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = { JWT_SECRET: 'test-upload-secret-0123456789' };
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: ADMIN, email: 'admin@x.dev', roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
    c.set('runtime', {
      cache: undefined,
      search: undefined,
      queue: undefined,
      storage: {
        put: async (key: string, body: ReadableStream) => {
          stored.set(key, (await new Response(body).arrayBuffer()).byteLength);
        },
      },
    } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/collections', collectionsRouter);
  app.route('/api/v1/relations', relationsRouter);
  app.route('/api/v1/items', itemsRouter);
  app.route('/api/v1/files', filesRouter);

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'images.ctfassets.net') {
      cdnHits.push(url.pathname);
      return new Response(ASSET_BYTES, { headers: { 'content-type': 'image/jpeg' } });
    }
    return app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;

  const env = { LUMIBASE_URL: 'http://cms.test', LUMIBASE_SITE_ID: SITE, LUMIBASE_TOKEN: 'test-token' };
  const run = (...flags: string[]) =>
    migrateCommand(parseArgs(['migrate', 'contentful', '--file', FIXTURE, '--locale-map', 'en-US=en', ...flags]), {
      cwd,
      env,
      fetcher,
      sleep: async () => {},
      confirm: async () => true,
    });

  beforeAll(async () => {
    db = await connectDbIntegration('migrate-contentful');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'lumibase-migrate-'));
    stored.clear();
    cdnHits.length = 0;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Migrate IT',
    });
    await db.insert(users).values({ id: ADMIN, email: 'migrate-admin@x.dev', status: 'active' }).onConflictDoNothing();
    const role = (await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id }))[0]!.id;
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: role });
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const collectionRow = async (name: string) =>
    (await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, name))))[0];
  const itemsOf = async (name: string) => {
    const coll = await collectionRow(name);
    return coll ? db.select().from(items).where(eq(items.collectionId, coll.id)) : [];
  };

  it('dry run plans 5 collections and writes nothing', async () => {
    expect(await run()).toBe(0);
    expect(await db.select().from(collections).where(eq(collections.siteId, SITE))).toHaveLength(0);
    expect(cdnHits).toHaveLength(0);
  });

  it('apply creates the schema, uploads assets and imports every entry with its source id (acceptance)', async () => {
    expect(await run('--apply')).toBe(0);

    // Schema: 5 collections with string primary keys, typed fields, the m2o relation.
    for (const name of ['author', 'category', 'blog_post', 'product', 'page']) {
      expect(await collectionRow(name)).toMatchObject({ primaryKeyType: 'string' });
    }
    const rels = await db.select().from(relations).where(eq(relations.siteId, SITE));
    expect(rels.map((r) => `${r.manyCollection}.${r.manyField}->${r.oneCollection}`)).toEqual(['blog_post.author->author']);

    // Assets: downloaded once each, stored, and registered as files.
    expect(cdnHits.sort()).toEqual(['/space/asset-avatar/lan.png', '/space/asset-hero/hero.jpg']);
    expect(stored.size).toBe(2);
    expect(await db.select().from(files).where(eq(files.siteId, SITE))).toHaveLength(2);
    const state = JSON.parse(readFileSync(join(cwd, '.lumibase/migrate-contentful.json'), 'utf8')) as { assets: Record<string, string> };
    expect(Object.keys(state.assets).sort()).toEqual(['asset-avatar', 'asset-hero']);

    // Entries: ids, statuses and converted values.
    const posts = await itemsOf('blog_post');
    expect(posts.map((p) => [p.id, p.status]).sort()).toEqual([
      ['post-brew', 'published'],
      ['post-old', 'archived'],
    ]);
    const brew = posts.find((p) => p.id === 'post-brew')!.data as Record<string, unknown>;
    expect(brew).toMatchObject({
      title: { en: 'How to brew', vi: 'Cách pha' },
      slug: 'how-to-brew',
      author: 'author-lan',
      categories: ['cat-guides', 'cat-news'],
      tags: ['coffee', 'howto'],
      hero_image: state.assets['asset-hero'],
      featured: true,
      status_field: 'guide',
    });
    const body = (brew.body as Record<string, RichTextDocument>).en!;
    expect(isRichTextDocument(body)).toBe(true);
    expect(body.content).toContainEqual({ type: 'embed', ref: { kind: 'file', id: state.assets['asset-hero'] } });
    expect(body.content).toContainEqual({ type: 'embed', ref: { kind: 'item', collection: 'product', id: 'product-beans' } });

    expect((await itemsOf('author')).map((a) => (a.data as Record<string, unknown>).avatar)).toEqual([state.assets['asset-avatar']]);
    expect((await itemsOf('category')).map((c) => [c.id, c.status]).sort()).toEqual([
      ['cat-guides', 'published'],
      ['cat-news', 'draft'],
    ]);
    expect((await itemsOf('product'))[0]!.data).toMatchObject({ price: 12.5, stock: 40, specs: { origin: 'Đà Lạt', roast: 'medium' } });
    expect((await itemsOf('page'))[0]!.data).toMatchObject({
      location: { type: 'Point', coordinates: [106.7009, 10.7769] },
      featured_item: { collection: 'blog_post', id: 'post-brew' },
      seo_score: { en: 90, vi: 85 },
    });
  });

  it('a second apply updates in place: no duplicate items, no re-uploaded assets', async () => {
    expect(await run('--apply')).toBe(0);
    const before = (await db.select().from(items).where(eq(items.siteId, SITE))).length;
    cdnHits.length = 0;
    expect(await run('--apply')).toBe(0);
    expect((await db.select().from(items).where(eq(items.siteId, SITE))).length).toBe(before);
    expect(before).toBe(7);
    expect(cdnHits).toHaveLength(0);
    expect(await db.select().from(files).where(eq(files.siteId, SITE))).toHaveLength(2);
  });

  it('adds only missing fields to an existing collection and never changes existing ones', async () => {
    const authorColl = (
      await db.insert(collections).values({ siteId: SITE, name: 'author', label: 'Author', primaryKeyType: 'string' }).returning({ id: collections.id })
    )[0]!.id;
    const { fields } = await import('@lumibase/database');
    await db.insert(fields).values([
      { siteId: SITE, collectionId: authorColl, name: 'name', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: authorColl, name: 'bio', type: 'integer', interface: 'input-number' },
    ]);
    expect(await run('--apply', '--skip-assets')).toBe(0);
    const authorFields = await db.select().from(fields).where(eq(fields.collectionId, authorColl));
    expect(Object.fromEntries(authorFields.map((f) => [f.name, f.type]))).toEqual({
      name: 'string',
      bio: 'integer', // untouched
      bio_contentful: 'json', // conflict → new field
      avatar: 'string',
    });
    const lan = (await itemsOf('author'))[0]!.data as Record<string, unknown>;
    expect(lan).toMatchObject({ name: 'Lan', bio_contentful: { en: 'Barista', vi: 'Pha chế' } });
  });

  it('refuses to apply when the confirmation is declined', async () => {
    const declined = await migrateCommand(parseArgs(['migrate', 'contentful', '--file', FIXTURE, '--apply']), {
      cwd,
      env,
      fetcher,
      confirm: async () => false,
    });
    expect(declined).toBe(1);
    expect(await db.select().from(collections).where(eq(collections.siteId, SITE))).toHaveLength(0);
  });

  it('rejects a file that is not a Contentful space export', async () => {
    const bad = join(cwd, 'bad.json');
    writeFileSync(bad, JSON.stringify({ items: [] }));
    await expect(
      migrateCommand(parseArgs(['migrate', 'contentful', '--file', bad]), { cwd, env, fetcher }),
    ).rejects.toThrow(/Not a Contentful space export/);
  });
});
