import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, revisions, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Revision comparison and field restore (#686) against REAL PostgreSQL.
 * Skips without DATABASE_URL (runs in the CI `db-integration` job).
 */

const SITE = 'site_686_compare';
const POSTS = 'posts';

describe.skipIf(!hasDbIntegrationUrl)('#686 revision compare — DB integration', () => {
  let db: Database;
  let svc: ItemService;

  beforeAll(async () => {
    db = await connectDbIntegration('revision-compare');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: '686 compare',
    });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: POSTS, label: 'Posts' })
      .returning({ id: collections.id });
    await db.insert(fields).values([
      { siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: coll!.id, name: 'body', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: coll!.id, name: 'secret', type: 'string', interface: 'input' },
    ]);
    svc = new ItemService({ db, siteId: SITE });
  });

  async function revisionIds(itemId: string): Promise<string[]> {
    const rows = await db
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.siteId, SITE), eq(revisions.itemId, itemId)))
      .orderBy(desc(revisions.createdAt));
    return rows.map((r) => r.id).reverse();
  }

  async function seedHistory(): Promise<{ id: string; revs: string[] }> {
    const created = (await svc.create(POSTS, { data: { title: 'v1', body: 'hello world' } })) as { id: string };
    await new Promise((r) => setTimeout(r, 5));
    await svc.patch(POSTS, created.id, { data: { title: 'v2' } });
    await new Promise((r) => setTimeout(r, 5));
    await svc.patch(POSTS, created.id, { data: { body: 'hello brave world' } });
    return { id: created.id, revs: await revisionIds(created.id) };
  }

  it('compares two revisions, a revision with the live item, and the empty state', async () => {
    const { id, revs } = await seedHistory();
    expect(revs).toHaveLength(3);

    const r1r2 = await svc.compareRevisions(POSTS, id, revs[0]!, revs[1]!);
    expect(r1r2.from?.id).toBe(revs[0]);
    expect(r1r2.changes.find((c) => c.key === 'title')).toMatchObject({ state: 'changed', before: 'v1', after: 'v2' });
    expect(r1r2.changes.find((c) => c.key === 'body')?.state).toBe('unchanged');

    const toCurrent = await svc.compareRevisions(POSTS, id, revs[0]!, 'current');
    expect(toCurrent.to).toBe('current');
    expect(toCurrent.after).toMatchObject({ title: 'v2', body: 'hello brave world' });

    const fromEmpty = await svc.compareRevisions(POSTS, id, null, revs[0]!);
    expect(fromEmpty.from).toBeNull();
    expect(fromEmpty.changes.every((c) => c.state === 'added')).toBe(true);
  });

  it('404s on a revision of another item', async () => {
    const a = await seedHistory();
    const b = (await svc.create(POSTS, { data: { title: 'other' } })) as { id: string };
    await expect(svc.compareRevisions(POSTS, b.id, a.revs[0]!, 'current')).rejects.toMatchObject({ status: 404 });
  });

  it('restores one field from a revision as a new revision', async () => {
    const { id, revs } = await seedHistory();
    const restored = await svc.restoreRevisionFields(POSTS, id, revs[0]!, ['body']);
    expect(restored.data).toMatchObject({ title: 'v2', body: 'hello world' });
    expect(await revisionIds(id)).toHaveLength(4);

    // A field absent from the snapshot is restored as null; unknown fields are refused.
    await svc.patch(POSTS, id, { data: { secret: 's' } });
    const cleared = await svc.restoreRevisionFields(POSTS, id, revs[0]!, ['secret']);
    expect(cleared.data.secret).toBeNull();
    await expect(svc.restoreRevisionFields(POSTS, id, revs[0]!, ['nope'])).rejects.toMatchObject({
      code: 'UNKNOWN_FIELD',
    });
  });

  it('restores every field when none are named', async () => {
    const { id, revs } = await seedHistory();
    const restored = await svc.restoreRevisionFields(POSTS, id, revs[0]!);
    expect(restored.data).toMatchObject({ title: 'v1', body: 'hello world' });
  });

  it('masks fields the caller cannot read', async () => {
    const { id, revs } = await seedHistory();
    await svc.patch(POSTS, id, { data: { secret: 'classified' } });
    const masked = new ItemService({ db, siteId: SITE });
    (masked as unknown as { permissions: unknown }).permissions = {
      canAccess: async () => ({ fields: ['title', 'body'], rule: null, presets: {}, validation: {} }),
      whereFor: () => undefined,
      maskItem: <T extends { data?: Record<string, unknown> }>(_p: unknown, item: T) => {
        const { secret: _s, ...rest } = item.data ?? {};
        return { ...item, data: rest };
      },
    };
    const res = await masked.compareRevisions(POSTS, id, revs[0]!, 'current');
    expect('secret' in res.after).toBe(false);
    expect(res.changes.some((c) => c.key === 'secret')).toBe(false);
  });
});
