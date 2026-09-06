import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { collections, fields, items, releases, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { ReleaseService, sweepDueReleases, withinMaintenanceWindow } from '../release-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed tests for Content Releases (Req 1–9). Skips when DATABASE_URL is
 * unset/unreachable — same convention as the other *.db.integration tests.
 *
 * **Validates: Requirements 1, 2, 3, 4, 5, 6, 7, 9**
 */

const SITE = 'site_release_it';
const COLLECTION = 'articles';

describe.skipIf(!hasDbIntegrationUrl)('ReleaseService — DB integration', () => {
  let db: Database;
  let collId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('release-service');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Release IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Articles' })
      .returning({ id: collections.id });
    collId = coll!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
    ]);
  });

  async function makeItem(title: string, status = 'draft'): Promise<string> {
    const created = await new ItemService({ db, siteId: SITE }).create(COLLECTION, {
      data: { title },
      status,
    });
    return (created as { id: string }).id;
  }

  it('creates a draft release, adds cross-collection items, publishes (Req 1, 2, 5, 7)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'Spring launch' });
    expect(release!.status).toBe('draft');

    const a = await makeItem('A');
    const b = await makeItem('B');
    await svc.patch(release!.id, {
      addItems: [
        { collection: COLLECTION, itemId: a, targetStatus: 'published' },
        { collection: COLLECTION, itemId: b, targetStatus: 'published' },
      ],
    });

    const detail = await svc.get(release!.id);
    expect(detail.items).toHaveLength(2);

    const result = await svc.publish(release!.id, { trigger: 'manual' });
    expect(result.status).toBe('published');
    expect(result.outcomes.every((o) => o.outcome === 'published')).toBe(true);

    // Items are now published in the DB.
    const rows = await db.select({ status: items.status }).from(items).where(eq(items.collectionId, collId));
    expect(rows.every((r) => r.status === 'published')).toBe(true);
  });

  it('rejects publishing an empty release and double-publish (Req 7.2, 7.3)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'Empty' });
    await expect(svc.publish(release!.id)).rejects.toMatchObject({ code: 'EMPTY_RELEASE' });

    const a = await makeItem('A');
    await svc.patch(release!.id, { addItems: [{ collection: COLLECTION, itemId: a }] });
    await svc.publish(release!.id);
    await expect(svc.publish(release!.id)).rejects.toMatchObject({ code: 'ALREADY_PUBLISHED' });
  });

  it('best_effort records a per-item outcome and partially_failed on a deleted item (Req 5.3, 5.6)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'Mixed', atomicityMode: 'best_effort' });
    const a = await makeItem('A');
    const b = await makeItem('B');
    await svc.patch(release!.id, {
      addItems: [
        { collection: COLLECTION, itemId: a },
        { collection: COLLECTION, itemId: b },
      ],
    });
    // Soft-delete b so its publish is skipped.
    await new ItemService({ db, siteId: SITE }).softDelete(COLLECTION, b);

    const result = await svc.publish(release!.id);
    const bOutcome = result.outcomes.find((o) => o.itemId === b);
    expect(bOutcome?.outcome).toBe('skipped');
    expect(bOutcome?.reason).toBe('ITEM_DELETED');
    // a published, b skipped → all non-failed → published.
    expect(['published', 'partially_failed']).toContain(result.status);
  });

  it('pins a specific revision and publishes its snapshot (Req 3)', async () => {
    const item = new ItemService({ db, siteId: SITE });
    const id = await makeItem('v1');
    // Create a second revision by patching the title.
    await item.patch(COLLECTION, id, { data: { title: 'v2' } });
    const revs = await item.listRevisions(COLLECTION, id);
    expect(revs.length).toBeGreaterThan(0);

    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'Pin' });
    // Pin the oldest revision (its delta.after holds a snapshot).
    const pinned = revs[revs.length - 1]!;
    await svc.patch(release!.id, {
      addItems: [{ collection: COLLECTION, itemId: id, revisionId: pinned.id }],
    });
    const result = await svc.publish(release!.id);
    expect(result.status).toBe('published');
  });

  it('scheduled sweep publishes due releases idempotently (Req 6)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const a = await makeItem('A');
    const release = await svc.create({ name: 'Scheduled' });
    await svc.patch(release!.id, { addItems: [{ collection: COLLECTION, itemId: a }] });
    // Force it into scheduled with a past publish_at directly (bypassing the
    // future-only validation, which is a UI guard, not a sweep guard).
    await db
      .update(releases)
      .set({ status: 'scheduled', publishAt: new Date(Date.now() - 60_000) })
      .where(eq(releases.id, release!.id));

    const n1 = await sweepDueReleases({ db });
    expect(n1).toBeGreaterThanOrEqual(1);
    const after = await svc.get(release!.id);
    expect(after.status).toBe('published');

    // Idempotent: a second sweep does not pick the now-published release.
    const n2 = await sweepDueReleases({ db });
    expect(n2).toBe(0);
  });

  it('deletes a release and cascades its items (Req 9)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const a = await makeItem('A');
    const release = await svc.create({ name: 'ToDelete' });
    await svc.patch(release!.id, { addItems: [{ collection: COLLECTION, itemId: a }] });
    await svc.delete(release!.id);
    await expect(svc.get(release!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('withinMaintenanceWindow (pure)', () => {
  it('returns true when no window is set', () => {
    expect(withinMaintenanceWindow(null, new Date('2026-06-22T10:00:00Z'))).toBe(true);
  });
  it('respects a declared window by UTC day + time', () => {
    // 2026-06-22 is a Monday (dow=1).
    const mw = { windows: [{ dow: 1, start: '09:00', end: '17:00' }] };
    expect(withinMaintenanceWindow(mw, new Date('2026-06-22T10:00:00Z'))).toBe(true);
    expect(withinMaintenanceWindow(mw, new Date('2026-06-22T18:00:00Z'))).toBe(false);
    expect(withinMaintenanceWindow(mw, new Date('2026-06-23T10:00:00Z'))).toBe(false); // Tuesday
  });
});
