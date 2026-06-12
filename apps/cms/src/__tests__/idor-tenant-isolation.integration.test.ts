import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  collections,
  createDb,
  items,
  revisions,
  sites,
  type Database,
} from '@lumibase/database';
import { ItemService } from '../services/item-service';

/**
 * IDOR / tenant-isolation tests for the `/items` surface
 * (docs/en/security/idor-testing.md).
 *
 * The routes resolve `siteId` from the tenant middleware and hand it to
 * `ItemService` — so the property under test lives at the service layer:
 * a service bound to tenant B, given an item id that belongs to tenant A,
 * must behave exactly as if the item does not exist (NOT_FOUND / empty /
 * no-op), even when both tenants have a collection with the SAME name.
 *
 * No `permissionCtx` is passed on purpose: isolation must come from
 * `siteId` scoping alone, never from the permission layer.
 *
 * Uses the repo's shared `DATABASE_URL` pattern: skips with a warning when
 * the variable is unset or the database is unreachable.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE_A = 'site_idor_a_it';
const SITE_B = 'site_idor_b_it';
const COLLECTION = 'articles';
const PINNED_FIELD = 'title';

describe('IDOR / Tenant Isolation for items', () => {
  let db: Database;
  let canConnect = false;
  let itemA: string;
  let revisionA: string;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping IDOR tenant-isolation tests: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping IDOR tenant-isolation tests: database not reachable.');
      canConnect = false;
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site)).catch(() => undefined);
    }
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Fresh slate; deleting the sites cascades into collections, items
    // and revisions. Both tenants get a collection with the SAME name so
    // the lookup in tenant B resolves a collection and isolation must
    // come from the item/revision site scoping.
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site));
    }
    await db.insert(sites).values([
      { id: SITE_A, name: 'IDOR tenant A' },
      { id: SITE_B, name: 'IDOR tenant B' },
    ]);
    const [collA] = await db
      .insert(collections)
      .values({ siteId: SITE_A, name: COLLECTION, label: 'Articles A' })
      .returning({ id: collections.id });
    await db
      .insert(collections)
      .values({ siteId: SITE_B, name: COLLECTION, label: 'Articles B' });
    const [item] = await db
      .insert(items)
      .values({
        siteId: SITE_A,
        collectionId: collA!.id,
        data: { title: 'Tenant A title', body: 'Tenant A body' },
        pinnedFields: [PINNED_FIELD],
      })
      .returning({ id: items.id });
    itemA = item!.id;
    const [rev] = await db
      .insert(revisions)
      .values({
        siteId: SITE_A,
        collectionId: collA!.id,
        itemId: itemA,
        delta: { before: null, after: { title: 'Tenant A title', body: 'Tenant A body' } },
        authorType: 'human',
      })
      .returning({ id: revisions.id });
    revisionA = rev!.id;
  });

  function serviceFor(siteId: string) {
    return new ItemService({ db, siteId });
  }

  async function itemARow() {
    const [row] = await db.select().from(items).where(eq(items.id, itemA)).limit(1);
    return row!;
  }

  describe('Single Item Operations', () => {
    it('GET /items/:collection/:id - should return 403/404 when accessing an item from another tenant', async () => {
      if (!canConnect) return;
      // Sanity: the owner tenant sees its item.
      const own = await serviceFor(SITE_A).detail(COLLECTION, itemA);
      expect((own.data as Record<string, unknown>).title).toBe('Tenant A title');

      await expect(serviceFor(SITE_B).detail(COLLECTION, itemA)).rejects.toMatchObject({
        name: 'ItemServiceError',
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('PATCH /items/:collection/:id - should return 403/404 when updating an item from another tenant', async () => {
      if (!canConnect) return;
      await expect(
        serviceFor(SITE_B).patch(COLLECTION, itemA, { data: { title: 'hijacked' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      // The write never happened.
      const row = await itemARow();
      expect((row.data as Record<string, unknown>).title).toBe('Tenant A title');
    });

    it('DELETE /items/:collection/:id - should return 403/404 when deleting an item from another tenant', async () => {
      if (!canConnect) return;
      await expect(serviceFor(SITE_B).softDelete(COLLECTION, itemA)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });

      const row = await itemARow();
      expect(row.deletedAt).toBeNull();
    });
  });

  describe('Bulk Operations', () => {
    it('POST /items/:collection/bulk (Update) - should block updates to items belonging to another tenant', async () => {
      if (!canConnect) return;
      await expect(
        serviceFor(SITE_B).bulk(COLLECTION, 'update', [{ id: itemA, title: 'hijacked' }]),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      const row = await itemARow();
      expect((row.data as Record<string, unknown>).title).toBe('Tenant A title');
    });

    it('POST /items/:collection/bulk (Delete) - should block deletion of items belonging to another tenant', async () => {
      if (!canConnect) return;
      await expect(
        serviceFor(SITE_B).bulk(COLLECTION, 'delete', [{ id: itemA }]),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      const row = await itemARow();
      expect(row.deletedAt).toBeNull();
    });
  });

  describe('Revisions and Pins', () => {
    it('GET /items/:collection/:id/revisions - should block viewing revisions of an item from another tenant', async () => {
      if (!canConnect) return;
      // Sanity: the owner tenant sees its revision history.
      expect(await serviceFor(SITE_A).listRevisions(COLLECTION, itemA)).toHaveLength(1);

      // The other tenant sees an empty history — indistinguishable from
      // an item that never existed.
      expect(await serviceFor(SITE_B).listRevisions(COLLECTION, itemA)).toEqual([]);
    });

    it('POST /items/:collection/:id/revert/:revisionId - should block reverting an item from another tenant', async () => {
      if (!canConnect) return;
      await expect(
        serviceFor(SITE_B).revertRevision(COLLECTION, itemA, revisionA),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      const row = await itemARow();
      expect((row.data as Record<string, unknown>).title).toBe('Tenant A title');
    });

    it('DELETE /items/:collection/:id/pins/:field - should block removing pins from an item of another tenant', async () => {
      if (!canConnect) return;
      await expect(
        serviceFor(SITE_B).releasePin(COLLECTION, itemA, PINNED_FIELD),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      // Law Zero holds: the human pin survives the cross-tenant attempt.
      const row = await itemARow();
      expect(row.pinnedFields).toEqual([PINNED_FIELD]);
    });
  });
});
