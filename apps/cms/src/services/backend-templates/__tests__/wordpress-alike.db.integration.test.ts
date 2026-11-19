import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { collections, items, roles, sites, userSites, users, type Database } from '@lumibase/database';
import { templateDigest } from '@lumibase/contracts/backend-templates';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { ConfigExportService } from '../../config-export-service';
import { ItemService } from '../../item-service';
import { OFFICIAL_TEMPLATES } from '../official';
import wordpressJson from '../official/wordpress-alike.template.json';
import { BackendTemplatePlanner, schemaFingerprint } from '../planner';
import { BackendTemplateInstaller } from '../installer';
import { createSeedWriter } from '../seed-writer';

/**
 * #907 (BT07) — the official `wordpress-alike` 1.0.0 template, installed for
 * real (official catalog → plan → install, with and without the demo pack)
 * into fresh sites on REAL PostgreSQL.
 */

const SITES = ['site_907_a', 'site_907_b', 'site_907_c'] as const;
const [A, B, C] = SITES;
const ADMIN = 'usr_907_admin';
const COLLECTIONS = ['authors', 'categories', 'comments', 'pages', 'post_categories', 'post_tags', 'posts', 'tags'];
const wordpress = OFFICIAL_TEMPLATES.find((t) => t.slug === 'wordpress-alike')!;

describe.skipIf(!hasDbIntegrationUrl)('#907 wordpress-alike — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('backend-template-wordpress');
  });
  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B}, ${C})`);
    await db.delete(users).where(eq(users.id, ADMIN));
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values(SITES.map((id) => ({ organizationId: org, id, name: id })));
    await db.insert(users).values({ id: ADMIN, email: 'admin-907@example.dev' });
    await db.insert(roles).values(SITES.map((siteId) => ({ id: `role_907_${siteId}`, siteId, name: 'Admin', adminAccess: true, appAccess: true })));
    await db.insert(userSites).values(SITES.map((siteId) => ({ userId: ADMIN, siteId, roleId: `role_907_${siteId}` })));
  });

  const itemsOf = (siteId: string, tx: Database = db) => new ItemService({
    db: tx, siteId, userId: ADMIN, suppressExtensionHooks: true,
    permissionCtx: { userId: ADMIN, siteId, roleId: `role_907_${siteId}`, ip: null, headers: {} },
  });

  async function install(siteId: string, seedPack: string | null) {
    const planner = new BackendTemplatePlanner({ db, siteId, cmsVersion: '2.2.0' });
    const { plan } = await planner.plan({
      template: { source: 'official', slug: 'wordpress-alike', version: '1.0.0' } as never,
      targetSiteId: siteId,
      ...(seedPack ? { seedMode: 'pack', seedPack } : {}),
    });
    const installer = new BackendTemplateInstaller({
      db, siteId, userId: ADMIN, authorize: async () => true,
      seed: createSeedWriter((tx) => itemsOf(siteId, tx)),
    });
    return (await installer.install({ planId: plan.id, idempotencyKey: `wp-${siteId}` })).installation;
  }

  const rows = async (siteId: string, collection: string) => {
    const [col] = await db.select().from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, collection)));
    return db.select().from(items).where(and(eq(items.siteId, siteId), eq(items.collectionId, col!.id)));
  };

  it('ships as a valid official template whose compatibility range is real', () => {
    expect(wordpress).toMatchObject({ slug: 'wordpress-alike', templateVersion: '1.0.0', compatibility: { cmsVersionRange: '>=2.1.0 <3.0.0' } });
    expect(wordpress.config.collections.map((c) => c.name).sort()).toEqual(COLLECTIONS);
    expect(wordpressJson.description).toMatch(/no WordPress REST API compatibility/);
  });

  it('BT07-AC01 — inventory: exactly the declared collections, fields and relations; nothing missing or extra', async () => {
    await install(B, null);
    const live = await new ConfigExportService({ db, siteId: B }).export({ scope: 'schema' });
    expect(live.collections.map((c) => c.name).sort()).toEqual(COLLECTIONS);
    const key = (f: { collection: string; field: string }) => `${f.collection}.${f.field}`;
    expect(live.fields.map(key).sort()).toEqual(wordpress.config.fields.map(key).sort());
    for (const declared of wordpress.config.fields) {
      const got = live.fields.find((f) => key(f) === key(declared))!;
      expect(got, key(declared)).toMatchObject({ type: declared.type, interface: declared.interface });
      if (declared.required) expect(got.required, key(declared)).toBe(true);
    }
    const rel = (r: { manyCollection: string; manyField: string; oneCollection: string }) => `${r.manyCollection}.${r.manyField}>${r.oneCollection}`;
    expect(live.relations.map(rel).sort()).toEqual(wordpress.config.relations.map(rel).sort());
  });

  it('BT07-AC02 — relations: author, page parent, comment post/author/parent and taxonomy joins resolve to the right records', async () => {
    const installation = await install(B, 'demo');
    const keys = (installation.resources as { seedKeys: Record<string, string> }).seedKeys;
    const data = async (collection: string, key: string) =>
      (await rows(B, collection)).find((r) => r.id === keys[key])!.data as Record<string, unknown>;
    expect((await data('posts', 'post-hello'))['author']).toBe(keys['author-ana']);
    expect((await data('pages', 'page-team'))['parent']).toBe(keys['page-about']);
    expect((await data('categories', 'cat-releases'))['parent']).toBe(keys['cat-news']);
    expect(await data('comments', 'comment-2')).toMatchObject({ post: keys['post-hello'], author: keys['author-ana'], parent: keys['comment-1'] });
    expect(await data('post_categories', 'pc-hello-releases')).toEqual({ post: keys['post-hello'], category: keys['cat-releases'] });
    expect(await data('post_tags', 'pt-draft-tips')).toEqual({ post: keys['post-draft'], tag: keys['tag-tips'] });
    // Relational reads follow the references in the target site.
    const expanded = await itemsOf(B).detail('posts', keys['post-hello']!, ['title', 'author.name']);
    expect(expanded).toMatchObject({ title: 'Hello, world', author: { name: 'Ana Example' } });
    const reply = await itemsOf(B).detail('comments', keys['comment-2']!, ['body', 'parent.body', 'post.title']);
    expect(reply).toMatchObject({ body: 'Thanks!', parent: { body: 'Nice first post.' }, post: { title: 'Hello, world' } });
    const child = await itemsOf(B).detail('pages', keys['page-team']!, ['title', 'parent.title']);
    expect(child).toMatchObject({ title: 'Team', parent: { title: 'About' } });
  });

  it('BT07-AC03 — field rules: required titles/names and declared options are enforced; defaults are the documented Studio defaults; nullable references accept null', async () => {
    await install(B, null);
    const service = itemsOf(B);
    await expect(service.create('posts', { data: { slug: 'no-title' } })).rejects.toMatchObject({ status: 400 });
    await expect(service.create('authors', { data: { slug: 'no-name' } })).rejects.toMatchObject({ status: 400 });
    await expect(service.create('posts', { data: { title: 'T', slug: 't', status: 'archived' } })).rejects.toMatchObject({ status: 400 });
    await expect(service.create('comments', { data: { author_name: 'x', body: 'y', status: 'deleted', post: 'p' } })).rejects.toMatchObject({ status: 400 });
    // Nullable references accept null; declared choices accept their values.
    const post = (await service.create('posts', { data: { title: 'OK', slug: 'ok', status: 'published', author: null } })) as { data: Record<string, unknown> };
    expect(post.data).toMatchObject({ status: 'published', author: null });
    // Defaults are declared for forms (Studio pre-fills them); the item API
    // stores what it receives and does not fill them in.
    const live = await new ConfigExportService({ db, siteId: B }).export({ scope: 'schema' });
    const status = live.fields.find((f) => f.collection === 'posts' && f.field === 'status')!;
    expect(status).toMatchObject({ defaultValue: 'draft' });
    const bare = (await service.create('posts', { data: { title: 'Bare', slug: 'bare' } })) as { data: Record<string, unknown> };
    expect(bare.data['status']).toBeUndefined();
  });

  it('BT07-AC04 — lightweight: no seed → all 8 collections empty, and the same schema fingerprint as the demo install', async () => {
    await install(B, null);
    await install(C, 'demo');
    for (const name of COLLECTIONS) expect(await rows(B, name), name).toEqual([]);
    expect((await schemaFingerprint(db, B)).fingerprint).toBe((await schemaFingerprint(db, C)).fingerprint);
  });

  it('BT07-AC05 — demo coherence: every collection and every declared relation is exercised with synthetic data only', async () => {
    const records = wordpress.seedPacks!['demo']!.records;
    expect(new Set(records.map((r) => r.collection))).toEqual(new Set(COLLECTIONS));
    for (const relation of wordpress.config.relations) {
      const used = records.some((r) => r.collection === relation.manyCollection && typeof r.references?.[relation.manyField] === 'string');
      expect(used, `${relation.manyCollection}.${relation.manyField}`).toBe(true);
    }
    // Parent-child examples on every self-reference.
    for (const [collection, field] of [['pages', 'parent'], ['categories', 'parent'], ['comments', 'parent']]) {
      expect(records.some((r) => r.collection === collection && r.references?.[field!])).toBe(true);
    }
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/password|token|secret|https?:\/\//i);
    for (const match of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) expect(match).toMatch(/\.invalid$/);
    const installation = await install(B, 'demo');
    expect((installation.resources as { seedRecords: number }).seedRecords).toBe(records.length);
    for (const name of COLLECTIONS) expect((await rows(B, name)).length, name).toBeGreaterThan(0);
  });

  it('BT07-AC06 — independent backends: content changes in one install leave another install and the template untouched', async () => {
    const digestBefore = await templateDigest(wordpress);
    const inA = await install(A, 'demo');
    await install(B, 'demo');
    const before = JSON.stringify((await Promise.all(COLLECTIONS.map((c) => rows(B, c)))).map((list) => list.map((r) => r.data).sort()));
    const keysA = (inA.resources as { seedKeys: Record<string, string> }).seedKeys;
    const service = itemsOf(A);
    await service.patch('posts', keysA['post-hello']!, { data: { title: 'Edited in A' } });
    await service.softDelete('comments', keysA['comment-3']!);
    const after = JSON.stringify((await Promise.all(COLLECTIONS.map((c) => rows(B, c)))).map((list) => list.map((r) => r.data).sort()));
    expect(after).toBe(before);
    expect(await templateDigest(OFFICIAL_TEMPLATES.find((t) => t.slug === 'wordpress-alike')!)).toBe(digestBefore);
  });
});
