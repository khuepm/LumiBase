import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  collections,
  fields,
  items,
  relations,
  revisions,
  sites,
  type Database,
} from '@lumibase/database';
import { ItemService } from '../item-service';
import { sweepDuePublish } from '../scheduler-worker';
import { pruneCollectionRevisions, sweepRevisionRetention } from '../revision-retention';
import { ItemDuplicateService, nextCopyValue } from '../item-duplicate';
import { SchemaService } from '../schema-service';
import { auditLog } from '@lumibase/database';
import { ReleaseService } from '../release-service';
import { ItemReorderService, midpoint } from '../item-reorder';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Epic #668 editorial UX against REAL PostgreSQL:
 *
 * - C03 (#687) publication stamps across patch, create and the scheduler;
 * - C04 (#688) `publicationState` cohorts on list, detail and nested relations;
 * - C09 (#693) `saveRevision=false` and the revision retention pruner.
 *
 * Skips without DATABASE_URL (runs in the CI `db-integration` job).
 */

const SITE = 'site_668_editorial';
const POSTS = 'posts';
const AUTHORS = 'authors';

let postsId = '';

async function seed(db: Database, postsMeta: Record<string, unknown> = {}): Promise<void> {
  await db.delete(sites).where(eq(sites.id, SITE));
  await db.insert(sites).values({
    organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
    id: SITE,
    name: '668 editorial',
  });
  const [posts] = await db
    .insert(collections)
    .values({ siteId: SITE, name: POSTS, label: 'Posts', meta: postsMeta })
    .returning({ id: collections.id });
  const [authors] = await db
    .insert(collections)
    .values({ siteId: SITE, name: AUTHORS, label: 'Authors' })
    .returning({ id: collections.id });
  postsId = posts!.id;
  const [comments] = await db
    .insert(collections)
    .values({ siteId: SITE, name: 'comments', label: 'Comments' })
    .returning({ id: collections.id });
  const [postTags] = await db
    .insert(collections)
    .values({ siteId: SITE, name: 'posts_tags', label: 'Posts tags' })
    .returning({ id: collections.id });
  await db.insert(fields).values([
    { siteId: SITE, collectionId: posts!.id, name: 'title', type: 'string', interface: 'input' },
    { siteId: SITE, collectionId: posts!.id, name: 'slug', type: 'string', interface: 'input', unique: true },
    { siteId: SITE, collectionId: posts!.id, name: 'author', type: 'string', interface: 'input' },
    { siteId: SITE, collectionId: posts!.id, name: 'headline', type: 'json', interface: 'translatable-text' },
    { siteId: SITE, collectionId: authors!.id, name: 'name', type: 'string', interface: 'input' },
    { siteId: SITE, collectionId: comments!.id, name: 'body', type: 'string', interface: 'input' },
    { siteId: SITE, collectionId: comments!.id, name: 'post', type: 'string', interface: 'input' },
    { siteId: SITE, collectionId: postTags!.id, name: 'post_id', type: 'string', interface: 'input' },
    { siteId: SITE, collectionId: postTags!.id, name: 'tag_id', type: 'string', interface: 'input' },
  ]);
  await db.insert(relations).values([
    { siteId: SITE, type: 'o2m', manyCollection: 'comments', manyField: 'post', oneCollection: POSTS },
    {
      siteId: SITE,
      type: 'm2m',
      manyCollection: POSTS,
      manyField: 'id',
      oneCollection: 'tags',
      junctionCollection: 'posts_tags',
      junctionManyField: 'post_id',
      junctionOneField: 'tag_id',
    },
  ]);
  await db.insert(relations).values({
    siteId: SITE,
    type: 'm2o',
    manyCollection: POSTS,
    manyField: 'author',
    oneCollection: AUTHORS,
    aliasField: 'writer',
  });
}

async function row(db: Database, id: string) {
  const [r] = await db.select().from(items).where(and(eq(items.siteId, SITE), eq(items.id, id)));
  return r!;
}

async function revisionCount(db: Database, id: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(revisions)
    .where(and(eq(revisions.siteId, SITE), eq(revisions.itemId, id)));
  return r?.n ?? 0;
}

describe.skipIf(!hasDbIntegrationUrl)('#668 editorial UX — DB integration', () => {
  let db: Database;
  let svc: ItemService;

  beforeAll(async () => {
    db = await connectDbIntegration('editorial-ux');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await seed(db);
    svc = new ItemService({ db, siteId: SITE });
  });

  describe('C03 publication stamps (#687)', () => {
    it('first publish stamps once; edits flip the flag; re-publish clears it', async () => {
      const created = (await svc.create(POSTS, { data: { title: 'a' } })) as { id: string };
      let r = await row(db, created.id);
      expect(r.firstPublishedAt).toBeNull();
      expect(r.hasUnpublishedChanges).toBe(false);

      await svc.patch(POSTS, created.id, { status: 'published' });
      r = await row(db, created.id);
      const first = r.firstPublishedAt;
      expect(first).toBeInstanceOf(Date);
      expect(r.publishedAt?.getTime()).toBe(first!.getTime());
      expect(r.hasUnpublishedChanges).toBe(false);

      await svc.patch(POSTS, created.id, { data: { title: 'b' } });
      expect((await row(db, created.id)).hasUnpublishedChanges).toBe(true);

      // A no-op save does not count as a change, and does not clear it either.
      await svc.patch(POSTS, created.id, { data: { title: 'b' } });
      expect((await row(db, created.id)).hasUnpublishedChanges).toBe(true);

      const modified = await svc.list(POSTS, { modifiedSincePublish: true });
      expect(modified.data.map((d) => (d as { id: string }).id)).toEqual([created.id]);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await svc.patch(POSTS, created.id, { status: 'published' });
      r = await row(db, created.id);
      expect(r.hasUnpublishedChanges).toBe(false);
      expect(r.firstPublishedAt?.getTime()).toBe(first!.getTime());
      expect(r.publishedAt!.getTime()).toBeGreaterThan(first!.getTime());
      expect((await svc.list(POSTS, { modifiedSincePublish: true })).data).toEqual([]);

      // Unpublish keeps the timestamps; editing the unpublished item marks it.
      await svc.patch(POSTS, created.id, { status: 'draft' });
      await svc.patch(POSTS, created.id, { data: { title: 'c' } });
      r = await row(db, created.id);
      expect(r.firstPublishedAt?.getTime()).toBe(first!.getTime());
      expect(r.hasUnpublishedChanges).toBe(true);
    });

    it('editing a never-published draft does not mark it modified', async () => {
      const created = (await svc.create(POSTS, { data: { title: 'a' } })) as { id: string };
      await svc.patch(POSTS, created.id, { data: { title: 'b' } });
      expect((await row(db, created.id)).hasUnpublishedChanges).toBe(false);
    });

    it('a scheduled publish stamps firstPublishedAt through the scheduler sweep', async () => {
      const past = new Date(Date.now() - 60_000);
      const created = (await svc.create(POSTS, { data: { title: 's' }, publishAt: past.toISOString() })) as {
        id: string;
      };
      await sweepDuePublish({ db });
      const r = await row(db, created.id);
      expect(r.status).toBe('published');
      expect(r.firstPublishedAt).toBeInstanceOf(Date);
      expect(r.publishedAt).toBeInstanceOf(Date);
    });
  });

  describe('C04 publicationState cohorts (#688)', () => {
    it('live / preview / all on list and detail', async () => {
      const draft = (await svc.create(POSTS, { data: { title: 'draft' } })) as { id: string };
      const live = (await svc.create(POSTS, { data: { title: 'live' }, status: 'published' })) as { id: string };
      const archived = (await svc.create(POSTS, { data: { title: 'arch' }, status: 'archived' })) as { id: string };
      const future = (await svc.create(POSTS, {
        data: { title: 'future' },
        status: 'published',
        publishAt: new Date(Date.now() + 3_600_000).toISOString(),
      })) as { id: string };

      const ids = async (state?: 'live' | 'preview' | 'all') =>
        (await new ItemService({ db, siteId: SITE, publicationState: state }).list(POSTS, { sort: ['id'] })).data
          .map((d) => (d as { id: string }).id)
          .sort();

      expect(await ids('live')).toEqual([live.id]);
      expect(await ids('preview')).toEqual([draft.id, live.id, future.id].sort());
      expect(await ids('all')).toEqual([draft.id, live.id, archived.id, future.id].sort());
      expect(await ids(undefined)).toEqual(await ids('all'));

      const liveSvc = new ItemService({ db, siteId: SITE, publicationState: 'live' });
      await expect(liveSvc.detail(POSTS, draft.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(liveSvc.detail(POSTS, live.id)).resolves.toMatchObject({ id: live.id });
    });

    it('nested relations follow the cohort', async () => {
      const draftAuthor = (await svc.create(AUTHORS, { data: { name: 'draft' } })) as { id: string };
      await svc.create(POSTS, { data: { title: 'p', author: draftAuthor.id }, status: 'published' });

      const read = async (state: 'live' | 'all') => {
        const res = await new ItemService({ db, siteId: SITE, publicationState: state }).list(POSTS, {
          fields: ['title', 'writer.name'],
        });
        return (res.data[0] as { writer?: unknown }).writer;
      };
      expect(await read('all')).toEqual({ name: 'draft' });
      expect(await read('live')).toBeNull();
    });
  });

  describe('C09 saveRevision=false and retention (#693)', () => {
    it('saveRevision=false skips the revision; the default records one', async () => {
      const created = (await svc.create(POSTS, { data: { title: 'a' } })) as { id: string };
      expect(await revisionCount(db, created.id)).toBe(1);

      const autosave = new ItemService({ db, siteId: SITE, saveRevision: false });
      await autosave.patch(POSTS, created.id, { data: { title: 'b' } });
      await autosave.patch(POSTS, created.id, { data: { title: 'c' } });
      expect(await revisionCount(db, created.id)).toBe(1);
      expect((await row(db, created.id)).data).toMatchObject({ title: 'c' });

      await svc.patch(POSTS, created.id, { data: { title: 'd' } });
      expect(await revisionCount(db, created.id)).toBe(2);
    });

    it('agent writes keep their revision even with saveRevision=false', async () => {
      const created = (await svc.create(POSTS, { data: { title: 'a' } })) as { id: string };
      const agent = new ItemService({
        db,
        siteId: SITE,
        saveRevision: false,
        provenance: { authorType: 'agent', runId: null },
      });
      await agent.patch(POSTS, created.id, { data: { title: 'agent' } });
      expect(await revisionCount(db, created.id)).toBe(2);
    });

    it('prunes beyond maxRevisions, keeps the newest and agent revisions', async () => {
      const created = (await svc.create(POSTS, { data: { title: 'v0' } })) as { id: string };
      for (let i = 1; i <= 5; i += 1) {
        await svc.patch(POSTS, created.id, { data: { title: `v${i}` } });
      }
      const agent = new ItemService({ db, siteId: SITE, provenance: { authorType: 'agent', runId: null } });
      await agent.patch(POSTS, created.id, { data: { title: 'agent' } });
      expect(await revisionCount(db, created.id)).toBe(7);

      const pruned = await pruneCollectionRevisions(db, SITE, postsId, { maxRevisions: 3 });
      // 7 rows ranked newest-first: agent(1), v5(2), v4(3) kept by rank; v3, v2,
      // v1, v0 pruned.
      expect(pruned).toBe(4);
      expect(await revisionCount(db, created.id)).toBe(3);
    });

    it('the sweep reads meta.revisionRetention and never drops the newest revision', async () => {
      await seed(db, { revisionRetention: { maxAgeDays: 1 } });
      svc = new ItemService({ db, siteId: SITE });
      const created = (await svc.create(POSTS, { data: { title: 'old' } })) as { id: string };
      await svc.patch(POSTS, created.id, { data: { title: 'older' } });
      await db
        .update(revisions)
        .set({ createdAt: sql`now() - interval '10 days'` })
        .where(eq(revisions.itemId, created.id));
      const pruned = await sweepRevisionRetention({ db });
      expect(pruned).toBeGreaterThanOrEqual(1);
      expect(await revisionCount(db, created.id)).toBe(1);
    });
  });

  describe('C05 duplicate / save-as-copy (#689)', () => {
    const dup = () =>
      new ItemDuplicateService({ db, siteId: SITE, items: svc, schema: new SchemaService({ db, siteId: SITE }) });

    it('suffixes copies of a copy without stacking', () => {
      expect(nextCopyValue('post', 1)).toBe('post-copy');
      expect(nextCopyValue('post-copy', 2)).toBe('post-copy-2');
      expect(nextCopyValue('post-copy-2', 3)).toBe('post-copy-3');
    });

    it('copies as a draft, resets the slug, keeps m2o and copies m2m links', async () => {
      const src = (await svc.create(POSTS, {
        data: { title: 'Hello', slug: 'hello', author: 'a1', headline: { en: 'Hi', vi: 'Chào' } },
        status: 'published',
      })) as { id: string };
      await svc.create('posts_tags', { data: { post_id: src.id, tag_id: 't1' } });
      await svc.create('comments', { data: { body: 'c', post: src.id } });

      const first = await dup().duplicate(POSTS, src.id);
      expect(first.item.status).toBe('draft');
      expect(first.item.data).toMatchObject({ title: 'Hello', slug: 'hello-copy', author: 'a1' });
      expect((await row(db, first.item.id)).firstPublishedAt).toBeNull();
      expect(first.related.posts_tags).toHaveLength(1);
      expect(first.related.comments).toBeUndefined();

      const second = await dup().duplicate(POSTS, src.id);
      expect(second.item.data).toMatchObject({ slug: 'hello-copy-2' });

      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'item_duplicated')))
        .limit(1);
      expect(audit?.metadata).toMatchObject({ sourceId: src.id, collection: POSTS });
    });

    it('deep copies o2m children; translations=false keeps one locale', async () => {
      const src = (await svc.create(POSTS, {
        data: { title: 'T', headline: { en: 'Hi', vi: 'Chào' } },
      })) as { id: string };
      await svc.create('comments', { data: { body: 'c1', post: src.id } });
      const res = await dup().duplicate(POSTS, src.id, { relations: 'deep', translations: false, locale: 'vi' });
      expect(res.item.data).toMatchObject({ headline: { vi: 'Chào' } });
      expect(res.related.comments).toHaveLength(1);
      const child = (await svc.detail('comments', res.related.comments![0]!)) as { data: Record<string, unknown> };
      expect(child.data).toMatchObject({ body: 'c1', post: res.item.id });
    });

    it('relations=none copies the item alone', async () => {
      const src = (await svc.create(POSTS, { data: { title: 'T' } })) as { id: string };
      await svc.create('posts_tags', { data: { post_id: src.id, tag_id: 't1' } });
      const res = await dup().duplicate(POSTS, src.id, { relations: 'none' });
      expect(res.related).toEqual({});
    });
  });

  describe('C08 release validation summary (#692)', () => {
    async function seedPages(): Promise<void> {
      const [pages] = await db
        .insert(collections)
        .values({ siteId: SITE, name: 'pages', label: 'Pages' })
        .returning({ id: collections.id });
      await db.insert(fields).values([
        { siteId: SITE, collectionId: pages!.id, name: 'title', type: 'string', interface: 'input' },
        { siteId: SITE, collectionId: pages!.id, name: 'body', type: 'string', interface: 'input', required: true },
      ]);
    }

    /** Insert straight into the table so the row can be invalid (as legacy/imported data can be). */
    async function rawItem(data: Record<string, unknown>): Promise<string> {
      const [coll] = await db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.siteId, SITE), eq(collections.name, 'pages')));
      const [r] = await db
        .insert(items)
        .values({ siteId: SITE, collectionId: coll!.id, data })
        .returning({ id: items.id });
      return r!.id;
    }

    it('lists invalid items with field paths and blocks an all_or_nothing publish', async () => {
      await seedPages();
      const ok = await rawItem({ title: 'ok', body: 'text' });
      const bad = await rawItem({ title: 'missing body' });
      const releases = new ReleaseService({ db, siteId: SITE });
      const release = await releases.create({ name: 'launch' });
      await releases.patch(release!.id, {
        addItems: [
          { collection: 'pages', itemId: ok, targetStatus: 'published' },
          { collection: 'pages', itemId: bad, targetStatus: 'published' },
        ],
      });

      const summary = await releases.validate(release!.id);
      expect(summary.valid).toBe(false);
      expect(summary.checked).toBe(2);
      expect(summary.items).toHaveLength(1);
      expect(summary.items[0]).toMatchObject({ collection: 'pages', itemId: bad });
      expect(summary.items[0]!.issues.map((i) => i.field)).toContain('body');

      const result = await releases.publish(release!.id);
      expect(result.status).toBe('failed');
      expect(result.outcomes.find((o) => o.itemId === bad)).toMatchObject({ reason: 'VALIDATION_FAILED' });
      expect((await row(db, ok)).status).toBe('draft');

      // Fixing the item clears the summary and lets the release publish.
      await db.update(items).set({ data: { title: 'fixed', body: 'now' } }).where(eq(items.id, bad));
      expect((await releases.validate(release!.id)).valid).toBe(true);
      const second = await releases.publish(release!.id);
      expect(second.status).toBe('published');
    });

    it('best_effort publishes the valid items and fails only the invalid one', async () => {
      await seedPages();
      const ok = await rawItem({ title: 'ok', body: 'text' });
      const bad = await rawItem({ title: 'missing body' });
      const releases = new ReleaseService({ db, siteId: SITE });
      const release = await releases.create({ name: 'best', atomicityMode: 'best_effort' });
      await releases.patch(release!.id, {
        addItems: [
          { collection: 'pages', itemId: ok, targetStatus: 'published' },
          { collection: 'pages', itemId: bad, targetStatus: 'published' },
        ],
      });
      const result = await releases.publish(release!.id);
      expect(result.status).toBe('partially_failed');
      expect((await row(db, ok)).status).toBe('published');
      expect((await row(db, bad)).status).toBe('draft');
    });
  });

  describe('C06 manual ordering (#690)', () => {
    async function manual(): Promise<{ svc: ItemService; reorder: ItemReorderService; ids: string[] }> {
      await seed(db, { manualSort: true });
      const msvc = new ItemService({ db, siteId: SITE });
      const ids: string[] = [];
      for (const t of ['a', 'b', 'c', 'd']) ids.push(((await msvc.create(POSTS, { data: { title: t } })) as { id: string }).id);
      return { svc: msvc, reorder: new ItemReorderService({ db, siteId: SITE, items: msvc }), ids };
    }
    const order = async (s: ItemService) =>
      (await s.list(POSTS, {})).data.map((d) => ((d as { data: { title: string } }).data.title)).join('');

    it('midpoint finds a gap or reports none', () => {
      expect(midpoint(0, 1024)).toBe(512);
      expect(midpoint(5, 6)).toBeNull();
      expect(midpoint(null, null)).toBe(0);
      expect(midpoint(2048, null)).toBe(3072);
    });

    it('appends new items and lists by manual order by default', async () => {
      const { svc: s } = await manual();
      expect(await order(s)).toBe('abcd');
    });

    it('moves one item with a single write and keeps others untouched', async () => {
      const { svc: s, reorder, ids } = await manual();
      const before = await db.select({ id: items.id, sort: items.sort }).from(items).where(eq(items.siteId, SITE));
      await reorder.reorder(POSTS, postsId, ids[3]!, { after: ids[0]! });
      expect(await order(s)).toBe('adbc');
      const after = await db.select({ id: items.id, sort: items.sort }).from(items).where(eq(items.siteId, SITE));
      const changed = after.filter((r) => before.find((b) => b.id === r.id)?.sort !== r.sort);
      expect(changed.map((r) => r.id)).toEqual([ids[3]]);

      await reorder.reorder(POSTS, postsId, ids[2]!, { after: null });
      expect(await order(s)).toBe('cadb');
      await reorder.reorder(POSTS, postsId, ids[0]!, { before: ids[1]! });
      expect(await order(s)).toBe('cdab');
    });

    it('renumbers once when the gap is exhausted (legacy rows all at sort 0)', async () => {
      const { svc: s, reorder, ids } = await manual();
      await db.update(items).set({ sort: 0 }).where(eq(items.siteId, SITE));
      // Ties fall back to creation order: a b c d.
      expect(await order(s)).toBe('abcd');
      await reorder.reorder(POSTS, postsId, ids[0]!, { after: ids[2]! });
      expect(await order(s)).toBe('bcad');
    });

    it('refuses to place an item next to itself and records no revision', async () => {
      const { reorder, ids } = await manual();
      await expect(reorder.reorder(POSTS, postsId, ids[0]!, { after: ids[0]! })).rejects.toMatchObject({ code: 'INVALID_REORDER' });
      const noRev = new ItemReorderService({
        db,
        siteId: SITE,
        items: new ItemService({ db, siteId: SITE, saveRevision: false }),
      });
      const revsBefore = await revisionCount(db, ids[1]!);
      await noRev.reorder(POSTS, postsId, ids[1]!, { after: null });
      expect(await revisionCount(db, ids[1]!)).toBe(revsBefore);
    });
  });
});
