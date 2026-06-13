import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  agentGoals,
  agentRuns,
  collections,
  createDb,
  items,
  revisions,
  sites,
  type Database,
} from '@lumibase/database';
import { VetoService } from '../veto-service';

/**
 * DB-backed test for the enriched `VetoService.listPending`
 * (content-os-ui task 9; Req 8.1-8.3): the exception inbox renders a real
 * field diff only if each staged entry carries collection/itemId/patch —
 * context that lives on the staging revision, not the approval row.
 *
 * Uses the repo's shared `DATABASE_URL` pattern: skips with a warning when
 * the variable is unset or the database is unreachable.
 *
 * **Validates: Requirements 8.1, 8.2, 8.4**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_veto_listing_it';
const COLLECTION = 'articles';

describe('VetoService.listPending — enriched staged listing', () => {
  let db: Database;
  let canConnect = false;
  let collectionId: string;
  let itemId: string;
  let runId: string;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping veto listPending DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping veto listPending DB test: database not reachable.');
      canConnect = false;
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Fresh slate: cascade from the site clears items, revisions, approvals.
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Veto listing IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Articles' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
    const [item] = await db
      .insert(items)
      .values({
        siteId: SITE,
        collectionId,
        data: { title: 'Human title', body: 'unchanged' },
      })
      .returning({ id: items.id });
    itemId = item!.id;
    const [goal] = await db
      .insert(agentGoals)
      .values({ siteId: SITE, title: 'rewrite stale article' })
      .returning({ id: agentGoals.id });
    const [run] = await db
      .insert(agentRuns)
      .values({ siteId: SITE, goalId: goal!.id })
      .returning({ id: agentRuns.id });
    runId = run!.id;
  });

  it('returns collection, itemId, patch and agentRole alongside the approval (Req 8.1)', async () => {
    if (!canConnect) return;
    const service = new VetoService({ db, siteId: SITE });
    const staged = await service.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: COLLECTION,
      itemId,
      patch: { title: 'Agent title' },
    });

    const pending = await service.listPending();
    expect(pending).toHaveLength(1);
    const entry = pending[0]!;
    expect(entry.approvalId).toBe(staged.approvalId);
    expect(entry.id).toBe(staged.approvalId);
    expect(entry.collection).toBe(COLLECTION);
    expect(entry.itemId).toBe(itemId);
    expect(entry.patch).toEqual({ title: 'Agent title' });
    expect(entry.agentRole).toBe('writer');
    // Approval fields stay intact for existing consumers.
    expect(entry.kind).toBe('veto');
    expect(entry.status).toBe('pending');
    expect(entry.autoCommitAt).toBeInstanceOf(Date);
  });

  it('keeps the entry with null context when the staging revision is gone (Req 8.2)', async () => {
    if (!canConnect) return;
    const service = new VetoService({ db, siteId: SITE });
    const staged = await service.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: COLLECTION,
      itemId,
      patch: { title: 'Agent title' },
    });
    await db.delete(revisions).where(eq(revisions.id, staged.revisionId));

    const pending = await service.listPending();
    expect(pending).toHaveLength(1);
    const entry = pending[0]!;
    expect(entry.approvalId).toBe(staged.approvalId);
    expect(entry.collection).toBeNull();
    expect(entry.itemId).toBeNull();
    expect(entry.patch).toBeNull();
  });

  it('never leaks stagings from another site (Req 8.3)', async () => {
    if (!canConnect) return;
    const service = new VetoService({ db, siteId: SITE });
    await service.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: COLLECTION,
      itemId,
      patch: { title: 'Agent title' },
    });

    const other = new VetoService({ db, siteId: 'site_that_does_not_exist' });
    expect(await other.listPending()).toEqual([]);
  });
});
