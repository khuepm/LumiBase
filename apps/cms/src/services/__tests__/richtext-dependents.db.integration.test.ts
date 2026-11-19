import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, fields, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { DependentsService } from '../dependents-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * #697 — an item referenced from rich text (link, inline or block embed,
 * custom-block ref, inside a blocks field too) cannot be deleted until the
 * reference is removed. Skips without DATABASE_URL.
 */

const SITE = 'site_rt_deps_it';
const SITE_B = `${SITE}_b`;
const ORG = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const link = (collection: string, id: string) => ({
  type: 'paragraph',
  content: [{ type: 'ref', ref: { kind: 'item', collection, id }, content: [{ type: 'text', text: 'see' }] }],
});

async function seedSite(db: Database, site: string): Promise<void> {
  await db.delete(sites).where(eq(sites.id, site));
  await db.insert(sites).values({ organizationId: ORG, id: site, name: site });
  const authors = (await db.insert(collections).values({ siteId: site, name: 'authors', label: 'Authors' }).returning({ id: collections.id }))[0]!.id;
  const posts = (await db.insert(collections).values({ siteId: site, name: 'posts', label: 'Posts' }).returning({ id: collections.id }))[0]!.id;
  await db.insert(fields).values([
    { siteId: site, collectionId: authors, name: 'name', type: 'string', interface: 'input' },
    { siteId: site, collectionId: authors, name: 'bio', type: 'richtext', interface: 'richtext' },
    { siteId: site, collectionId: posts, name: 'title', type: 'string', interface: 'input' },
    { siteId: site, collectionId: posts, name: 'body', type: 'richtext', interface: 'richtext' },
    // Content migrated before the field type existed: json + richtext interface, per locale.
    { siteId: site, collectionId: posts, name: 'legacy', type: 'json', interface: 'richtext' },
  ]);
}

describe.skipIf(!hasDbIntegrationUrl)('rich-text references block deletes (#697) — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('richtext-dependents');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
  });

  beforeEach(async () => {
    await seedSite(db, SITE);
  });

  it('blocks deleting an item linked, embedded or referenced from rich text', async () => {
    const item = new ItemService({ db, siteId: SITE });
    const author = (await item.create('authors', { data: { name: 'Lan' } })) as { id: string };
    const linked = (await item.create('posts', { data: { title: 'linked', body: doc(link('authors', author.id)) } })) as { id: string };
    const embedded = (await item.create('posts', {
      data: { title: 'embedded', body: doc(p('x'), { type: 'embed', ref: { kind: 'item', collection: 'authors', id: author.id } }) },
    })) as { id: string };
    const legacy = (await item.create('posts', { data: { title: 'legacy', legacy: { en: doc(link('authors', author.id)) } } })) as { id: string };
    const custom = (await item.create('posts', {
      data: { title: 'custom', body: doc({ type: 'custom', name: 'card', data: { ref: { kind: 'item', collection: 'authors', id: author.id } } }) },
    })) as { id: string };

    const svc = new DependentsService({ db, siteId: SITE });
    const report = await svc.report('authors', author.id);
    expect(report.blocking).toBe(true);
    const groups = Object.fromEntries(report.dependents.map((g) => [`${g.collection}.${g.field}`, g]));
    expect(groups['posts.body']).toMatchObject({ kind: 'richtext', onDelete: 'restrict', count: 3, relation: 'richtext:posts.body' });
    expect(groups['posts.body']!.sample.map((s) => s.id).sort()).toEqual([linked.id, embedded.id, custom.id].sort());
    expect(groups['posts.legacy']).toMatchObject({ kind: 'richtext', count: 1, sample: [{ id: legacy.id }] });
  });

  it('ignores the same id in other collections, plain text, self-links and deleted items', async () => {
    const item = new ItemService({ db, siteId: SITE });
    const author = (await item.create('authors', { data: { name: 'Lan' } })) as { id: string };
    // Same id but another collection, and the id as plain text: not a reference to this author.
    await item.create('posts', { data: { title: 'other', body: doc(link('posts', author.id), p(`mention ${author.id}`)) } });
    // A self-link in the author's own bio does not block deleting it.
    await item.patch('authors', author.id, { data: { bio: doc(link('authors', author.id)) } });
    // A referencing item that was deleted no longer counts.
    const gone = (await item.create('posts', { data: { title: 'gone', body: doc(link('authors', author.id)) } })) as { id: string };
    await item.softDelete('posts', gone.id);

    const report = await new DependentsService({ db, siteId: SITE }).report('authors', author.id);
    expect(report.dependents).toEqual([]);
    expect(report.blocking).toBe(false);
  });

  it('unblocks once the reference is removed; resolve-dependents refuses rich-text groups', async () => {
    const item = new ItemService({ db, siteId: SITE });
    const author = (await item.create('authors', { data: { name: 'Lan' } })) as { id: string };
    const post = (await item.create('posts', { data: { title: 'p', body: doc(link('authors', author.id)) } })) as { id: string };
    const svc = new DependentsService({ db, siteId: SITE });

    await expect(svc.applyResolution('authors', author.id, 'set_null', 'richtext:posts.body')).rejects.toMatchObject({
      code: 'RICHTEXT_REFERENCE',
      status: 422,
    });

    await item.patch('posts', post.id, { data: { body: doc(p('no more link')) } });
    expect((await svc.report('authors', author.id)).blocking).toBe(false);
  });

  it('never counts references from another site (tenant isolation)', async () => {
    const item = new ItemService({ db, siteId: SITE });
    const author = (await item.create('authors', { data: { name: 'Lan' } })) as { id: string };
    await seedSite(db, SITE_B);
    try {
      await new ItemService({ db, siteId: SITE_B }).create('posts', { data: { title: 'cross', body: doc(link('authors', author.id)) } });
      const report = await new DependentsService({ db, siteId: SITE }).report('authors', author.id);
      expect(report.dependents).toEqual([]);
    } finally {
      await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
    }
  });
});
