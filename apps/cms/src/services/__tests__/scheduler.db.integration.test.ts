import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { collections, items, sites, type Database } from '@lumibase/database';
import { runSchedulerTick } from '../scheduler-worker';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed scheduler integration (task 7.3; Req 7.3, 7.4, 7.6). Skips when
 * DATABASE_URL is unset/unreachable.
 *
 * **Validates: Requirements 7.3, 7.4, 7.6**
 */

const SITE = 'site_scheduler_it';
const COLLECTION = 'posts';

describe.skipIf(!hasDbIntegrationUrl)('Content scheduler — DB integration', () => {
  let db: Database;
  let collectionId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('scheduler');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Scheduler IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Posts' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
  });

  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 3_600_000);

  it('publishes due items and unpublishes elapsed ones; catch-up is idempotent (Req 7.6)', async () => {
    const [duePublish] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId, status: 'draft', data: {}, publishAt: past })
      .returning({ id: items.id });
    const [notYet] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId, status: 'draft', data: {}, publishAt: future })
      .returning({ id: items.id });
    const [dueUnpublish] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId, status: 'published', data: {}, unpublishAt: past })
      .returning({ id: items.id });

    const first = await runSchedulerTick({ db });
    expect(first.published).toBe(1);
    expect(first.unpublished).toBe(1);

    const byId = async (id: string) =>
      (await db.select().from(items).where(eq(items.id, id)))[0]!;
    expect((await byId(duePublish!.id)).status).toBe('published');
    expect((await byId(duePublish!.id)).editorialState).toBe('published');
    expect((await byId(notYet!.id)).status).toBe('draft'); // future publishAt untouched
    expect((await byId(dueUnpublish!.id)).status).toBe('archived');

    // Second tick over the same instant flips nothing more (idempotent).
    const second = await runSchedulerTick({ db });
    expect(second.published).toBe(0);
    expect(second.unpublished).toBe(0);
  });
});
