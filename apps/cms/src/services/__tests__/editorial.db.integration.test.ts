import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  collections,
  contentReviews,
  createDb,
  items,
  sites,
  users,
  type Database,
} from '@lumibase/database';
import { ItemService, ItemServiceError } from '../item-service';
import { EditorialService } from '../editorial-service';

/**
 * DB-backed editorial workflow integration (task 8.6; Req 8, 9). Skips when
 * DATABASE_URL is unset/unreachable.
 *
 * **Validates: Requirements 8.2, 8.3, 9.1, 9.3**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_editorial_it';
const GATED = 'gated_articles';
const OPEN = 'open_articles';

describe('Editorial workflow — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let gatedId: string;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping editorial DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping editorial DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, 'author')).catch(() => undefined);
    await db.delete(users).where(eq(users.id, 'reviewer')).catch(() => undefined);
    await db.insert(sites).values({ id: SITE, name: 'Editorial IT' });
    await db.insert(users).values([
      { id: 'author', email: 'author@test.local' },
      { id: 'reviewer', email: 'reviewer@test.local' },
    ]);
    const [gated] = await db
      .insert(collections)
      .values({ siteId: SITE, name: GATED, label: 'Gated', meta: { editorialWorkflow: true, requireSeparateReviewer: true } })
      .returning({ id: collections.id });
    gatedId = gated!.id;
    await db
      .insert(collections)
      .values({ siteId: SITE, name: OPEN, label: 'Open', meta: {} });
  });

  const svc = (userId?: string) => new ItemService({ db, siteId: SITE, userId: userId ?? null });
  const editorial = (userId: string) => new EditorialService({ db, siteId: SITE, userId });

  it('blocks direct draft -> published on a workflow collection (Req 8.2)', async () => {
    if (!canConnect) return;
    const item = await svc('author').create(GATED, { data: { title: 'X' } });
    await expect(
      svc('author').patch(GATED, item.id, { status: 'published' }),
    ).rejects.toMatchObject({ code: 'EDITORIAL_GATE_REQUIRED', status: 409 });
  });

  it('allows the review -> approve -> published path with a separate reviewer', async () => {
    if (!canConnect) return;
    const item = await svc('author').create(GATED, { data: { title: 'Y' } });

    await editorial('author').submitReview(GATED, item.id, { assignedTo: 'reviewer' });
    let [row] = await db.select().from(items).where(eq(items.id, item.id));
    expect(row!.editorialState).toBe('in_review');

    // Same author cannot approve (separate-reviewer rule).
    await expect(editorial('author').approve(GATED, item.id)).rejects.toMatchObject({
      code: 'SEPARATE_REVIEWER_REQUIRED',
    });

    // A different reviewer approves → editorial_state approved.
    await editorial('reviewer').approve(GATED, item.id, { reason: 'ok' });
    [row] = await db.select().from(items).where(eq(items.id, item.id));
    expect(row!.editorialState).toBe('approved');

    const reviews = await db.select().from(contentReviews).where(eq(contentReviews.itemId, item.id));
    expect(reviews[0]!.status).toBe('approved');
    expect(reviews[0]!.decidedBy).toBe('reviewer');

    // Now publish is allowed (current state is approved).
    const published = await svc('author').patch(GATED, item.id, { status: 'published' });
    expect(published.status).toBe('published');
  });

  it('leaves workflow-off collections unchanged: draft -> published directly (Req 8.3)', async () => {
    if (!canConnect) return;
    const item = await svc('author').create(OPEN, { data: { title: 'Z' } });
    const published = await svc('author').patch(OPEN, item.id, { status: 'published' });
    expect(published.status).toBe('published');
  });

  it('rejects with reason returns the item to draft', async () => {
    if (!canConnect) return;
    const item = await svc('author').create(GATED, { data: { title: 'R' } });
    await editorial('author').submitReview(GATED, item.id);
    await editorial('reviewer').reject(GATED, item.id, { reason: 'needs work' });
    const [row] = await db.select().from(items).where(eq(items.id, item.id));
    expect(row!.editorialState).toBe('rejected');
    const reviews = await db.select().from(contentReviews).where(eq(contentReviews.itemId, item.id));
    expect(reviews[0]!.status).toBe('rejected');
    expect(reviews[0]!.reason).toBe('needs work');
    void ItemServiceError;
  });
});
