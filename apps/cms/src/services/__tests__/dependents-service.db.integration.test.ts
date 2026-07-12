import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, createDb, fields, items, relations, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { DependentsService } from '../dependents-service';

/**
 * DB-backed tests for the FK dependent-records handler (Req 1, 4, 5, 6, 7).
 * Models: `comments.article → articles` (m2o). Skips without DATABASE_URL.
 *
 * **Validates: Requirements 1, 4 (restrict blocks), 5 (set_null), 6 (delete), 7 (reassign)**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_deps_it';

describe('DependentsService — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let articlesId = '';
  let commentsId = '';

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping dependents DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping dependents DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Deps IT' });
    articlesId = (await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id }))[0]!.id;
    commentsId = (await db.insert(collections).values({ siteId: SITE, name: 'comments', label: 'Comments' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: articlesId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: commentsId, name: 'body', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: commentsId, name: 'article', type: 'string', interface: 'input' },
    ]);
  });

  async function relation(onDelete: string): Promise<void> {
    await db.delete(relations).where(eq(relations.siteId, SITE));
    await db.insert(relations).values({
      siteId: SITE,
      manyCollection: 'comments',
      manyField: 'article',
      oneCollection: 'articles',
      type: 'm2o',
      onDelete,
    });
  }

  async function seedArticleWithComments(n: number): Promise<{ articleId: string; commentIds: string[] }> {
    const item = new ItemService({ db, siteId: SITE });
    const article = (await item.create('articles', { data: { title: 'A' } })) as { id: string };
    const commentIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const cm = (await item.create('comments', { data: { body: `c${i}`, article: article.id } })) as { id: string };
      commentIds.push(cm.id);
    }
    return { articleId: article.id, commentIds };
  }

  it('finds reverse dependents with the right count + onDelete (Req 1)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(3);
    const svc = new DependentsService({ db, siteId: SITE });
    const report = await svc.report('articles', articleId);
    expect(report.dependents).toHaveLength(1);
    expect(report.dependents[0]).toMatchObject({ collection: 'comments', field: 'article', onDelete: 'restrict', count: 3 });
    expect(report.blocking).toBe(true);
  });

  it('does not block when the relation is set null (Req 4)', async () => {
    if (!canConnect) return;
    await relation('set null');
    const { articleId } = await seedArticleWithComments(2);
    const svc = new DependentsService({ db, siteId: SITE });
    expect((await svc.report('articles', articleId)).blocking).toBe(false);
  });

  it('set_null clears the reference on every dependent (Req 5)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(2);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    const res = await svc.applyResolution('articles', articleId, 'set_null', rel.id);
    expect(res.affected).toBe(2);
    expect((await svc.report('articles', articleId)).dependents).toHaveLength(0);
  });

  it('reassign points dependents at a new target (Req 7)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(2);
    const item = new ItemService({ db, siteId: SITE });
    const other = (await item.create('articles', { data: { title: 'B' } })) as { id: string };
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    const res = await svc.applyResolution('articles', articleId, 'reassign', rel.id, { newTargetId: other.id });
    expect(res.affected).toBe(2);
    expect((await svc.report('articles', articleId)).dependents).toHaveLength(0);
    expect((await svc.report('articles', other.id)).dependents[0]?.count).toBe(2);
  });

  it('reassign rejects a missing/self target (Req 7.2)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(1);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    await expect(svc.applyResolution('articles', articleId, 'reassign', rel.id, { newTargetId: 'nope' })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('delete soft-deletes every dependent (Req 6)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    const { articleId, commentIds } = await seedArticleWithComments(2);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    const res = await svc.applyResolution('articles', articleId, 'delete', rel.id);
    expect(res.affected).toBe(2);
    // dependents now soft-deleted → no longer counted.
    expect((await svc.report('articles', articleId)).dependents).toHaveLength(0);
    const [c] = await db.select({ deletedAt: items.deletedAt }).from(items).where(eq(items.id, commentIds[0]!)).limit(1);
    expect(c?.deletedAt).not.toBeNull();
  });

  it('does not count dependents from another site (tenant isolation, Req 1)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(2);

    // A second site with a comment referencing the SAME article id string.
    const SITE_B = `${SITE}_b`;
    await db.delete(sites).where(eq(sites.id, SITE_B));
    await db.insert(sites).values({ id: SITE_B, name: 'Deps IT B' });
    const bArticles = (await db.insert(collections).values({ siteId: SITE_B, name: 'articles', label: 'A' }).returning({ id: collections.id }))[0]!.id;
    const bComments = (await db.insert(collections).values({ siteId: SITE_B, name: 'comments', label: 'C' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE_B, collectionId: bArticles, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE_B, collectionId: bComments, name: 'body', type: 'string', interface: 'input' },
      { siteId: SITE_B, collectionId: bComments, name: 'article', type: 'string', interface: 'input' },
    ]);
    await db.insert(relations).values({ siteId: SITE_B, manyCollection: 'comments', manyField: 'article', oneCollection: 'articles', type: 'm2o', onDelete: 'restrict' });
    const itemB = new ItemService({ db, siteId: SITE_B });
    await itemB.create('comments', { data: { body: 'cross', article: articleId } });

    try {
      // Site A only sees its own 2 comments — never site B's cross-referencing one.
      const svc = new DependentsService({ db, siteId: SITE });
      const report = await svc.report('articles', articleId);
      expect(report.dependents).toHaveLength(1);
      expect(report.dependents[0]!.count).toBe(2);
    } finally {
      await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
    }
  });

  it('set_null is rejected when the field is required (Req 5.3)', async () => {
    if (!canConnect) return;
    await relation('restrict');
    await db.update(fields).set({ required: true }).where(sql`${fields.collectionId} = ${commentsId} and ${fields.name} = 'article'`);
    const { articleId } = await seedArticleWithComments(1);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    await expect(svc.applyResolution('articles', articleId, 'set_null', rel.id)).rejects.toMatchObject({ code: 'FIELD_REQUIRED' });
  });
});
