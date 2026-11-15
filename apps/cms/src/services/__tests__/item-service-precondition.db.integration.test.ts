import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, items, sites, type Database } from '@lumibase/database';
import { ItemService, ItemServiceError } from '../item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Optimistic concurrency on item writes. Without `If-Match` the legacy
 * last-write-wins behaviour is unchanged; with it, the version check is
 * atomic with the UPDATE. Skips without DATABASE_URL (runs in CI).
 *
 * **Validates: content-environments Req 6.1-6.4 (gate GA).**
 */

const SITE = 'site_precond_it';

async function versionOf(db: Database, id: string): Promise<number> {
  const [row] = await db
    .select({ version: items.version })
    .from(items)
    .where(and(eq(items.siteId, SITE), eq(items.id, id)));
  return row!.version;
}

async function expectPreconditionFailed(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ItemServiceError);
  expect((err as ItemServiceError).code).toBe('PRECONDITION_FAILED');
  expect((err as ItemServiceError).status).toBe(412);
}

describe.skipIf(!hasDbIntegrationUrl)('ItemService write precondition (If-Match)', () => {
  let db: Database;
  let svc: ItemService;

  beforeAll(async () => {
    db = await connectDbIntegration('item-service-precondition');
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
      name: 'Precondition IT',
    });
    const collId = (
      await db
        .insert(collections)
        .values({ siteId: SITE, name: 'posts', label: 'Posts' })
        .returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'body', type: 'string', interface: 'input' },
    ]);
    svc = new ItemService({ db, siteId: SITE });
  });

  it('new items start at version 0 and every patch increments it', async () => {
    const created = (await svc.create('posts', { data: { title: 'A' } })) as { id: string; version: number };
    expect(created.version).toBe(0);
    const patched = (await svc.patch('posts', created.id, { data: { title: 'B' } })) as { version: number };
    expect(patched.version).toBe(1);
    await svc.replace('posts', created.id, { data: { title: 'C' } });
    expect(await versionOf(db, created.id)).toBe(2);
  });

  it('without a precondition, writes behave as before (last write wins)', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A', body: 'x' } })) as { id: string };
    await svc.patch('posts', id, { data: { title: 'first' } });
    await svc.patch('posts', id, { data: { title: 'second' } });
    const row = (await svc.detail('posts', id)) as { data: Record<string, unknown> };
    expect(row.data).toEqual({ title: 'second', body: 'x' });
  });

  it('a matching version writes; a stale one fails with 412 and writes nothing', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };

    await svc.patch('posts', id, { data: { title: 'B' } }, { expectedVersions: [0] });
    expect(await versionOf(db, id)).toBe(1);

    await expectPreconditionFailed(svc.patch('posts', id, { data: { title: 'stale' } }, { expectedVersions: [0] }));
    const row = (await svc.detail('posts', id)) as { data: Record<string, unknown> };
    expect(row.data.title).toBe('B');
    expect(await versionOf(db, id)).toBe(1);

    // Any listed version may match.
    await svc.patch('posts', id, { data: { title: 'C' } }, { expectedVersions: [7, 1] });
    expect(await versionOf(db, id)).toBe(2);
  });

  it('an empty expected list never matches', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };
    await expectPreconditionFailed(svc.patch('posts', id, { data: { title: 'B' } }, { expectedVersions: [] }));
    expect(await versionOf(db, id)).toBe(0);
  });

  it('replace honours the precondition', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };
    await expectPreconditionFailed(svc.replace('posts', id, { data: { title: 'B' } }, { expectedVersions: [5] }));
    await svc.replace('posts', id, { data: { title: 'B' } }, { expectedVersions: [0] });
    expect(await versionOf(db, id)).toBe(1);
  });

  it('two concurrent writes with the same version: exactly one wins', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A', body: 'x' } })) as { id: string };
    const other = new ItemService({ db, siteId: SITE });

    const results = await Promise.allSettled([
      svc.patch('posts', id, { data: { title: 'from-1' } }, { expectedVersions: [0] }),
      other.patch('posts', id, { data: { body: 'from-2' } }, { expectedVersions: [0] }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as ItemServiceError).code).toBe('PRECONDITION_FAILED');
    expect(await versionOf(db, id)).toBe(1);

    // The stored row is exactly the winner's write: the loser changed nothing.
    const row = (await svc.detail('posts', id)) as { data: Record<string, unknown> };
    const winnerIsFirst = results[0]!.status === 'fulfilled';
    expect(row.data).toEqual(winnerIsFirst ? { title: 'from-1', body: 'x' } : { title: 'A', body: 'from-2' });
  });

  it('a write landing between the read and the UPDATE is still caught', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };
    // Simulate a concurrent writer that bumps the version directly.
    await db
      .update(items)
      .set({ version: sql`${items.version} + 1` })
      .where(and(eq(items.siteId, SITE), eq(items.id, id)));
    await expectPreconditionFailed(svc.patch('posts', id, { data: { title: 'B' } }, { expectedVersions: [0] }));
  });

  it('detail reports the version through the meta out-parameter, even with field projection', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };
    await svc.patch('posts', id, { data: { title: 'B' } });
    const meta: { version?: number } = {};
    await svc.detail('posts', id, ['title'], undefined, meta);
    expect(meta.version).toBe(1);
  });

  it('write coalescing defers only invalidation, never the version check', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };
    svc.beginWriteCoalescing();
    await svc.patch('posts', id, { data: { title: 'B' } }, { expectedVersions: [0] });
    // The first write is already in the row, so a second write holding the
    // old tag must fail even though invalidation has not been flushed.
    await expectPreconditionFailed(svc.patch('posts', id, { data: { title: 'C' } }, { expectedVersions: [0] }));
    await svc.patch('posts', id, { data: { title: 'C' } }, { expectedVersions: [1] });
    await svc.flushCoalescedWrites();
    expect(await versionOf(db, id)).toBe(2);
  });

  it('crypto-shred and soft delete increment the version', async () => {
    const { id } = (await svc.create('posts', { data: { title: 'A' } })) as { id: string };
    await svc.cryptoShred('posts', id);
    expect(await versionOf(db, id)).toBe(1);
    await svc.softDelete('posts', id);
    expect(await versionOf(db, id)).toBe(2);
  });
});
