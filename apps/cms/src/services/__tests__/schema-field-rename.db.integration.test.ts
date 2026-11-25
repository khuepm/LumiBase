import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, items, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { SchemaService, SchemaServiceError } from '../schema-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Field rename moves item data (B213 follow-up): `SchemaService.renameField`
 * — and every path that reaches it (`updateField` with a new `name`,
 * `upsertField`/`updateSchema` with `renameFrom`) — moves `data[from]` to
 * `data[to]` in the same transaction as the field row, scoped to the site and
 * collection. Skips without DATABASE_URL.
 */

const SITE = 'site_field_rename_it';
const OTHER = 'site_field_rename_it_b';
const FIELD = { type: 'string', interface: 'input' } as const;

async function seedSite(db: Database, siteId: string): Promise<void> {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.insert(sites).values({
    organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
    id: siteId,
    name: siteId,
  });
  const [coll] = await db.insert(collections).values({ siteId, name: 'posts' }).returning({ id: collections.id });
  await db.insert(fields).values([
    { siteId, collectionId: coll!.id, name: 'title', ...FIELD },
    { siteId, collectionId: coll!.id, name: 'summary', ...FIELD },
    { siteId, collectionId: coll!.id, name: 'secret', ...FIELD, encrypted: true },
  ]);
}

describe.skipIf(!hasDbIntegrationUrl)('SchemaService field rename — DB integration', () => {
  let db: Database;

  const schemaOf = (siteId: string) => new SchemaService({ db, siteId });
  const itemsOf = (siteId: string) => new ItemService({ db, siteId });
  const rowsOf = (siteId: string) => db.select().from(items).where(eq(items.siteId, siteId)).orderBy(items.id);
  const insertItem = async (siteId: string, data: Record<string, unknown>, extra: Partial<typeof items.$inferInsert> = {}) => {
    const [coll] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, siteId), eq(collections.name, 'posts')));
    const [row] = await db.insert(items).values({ siteId, collectionId: coll!.id, data, ...extra }).returning();
    return row!;
  };

  beforeAll(async () => {
    db = await connectDbIntegration('schema-field-rename');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, OTHER)).catch(() => undefined);
  });

  beforeEach(async () => {
    await seedSite(db, SITE);
    await seedSite(db, OTHER);
  });

  it('renameField moves the value to the new key, drops the old key and bumps version; other sites untouched', async () => {
    const a = await insertItem(SITE, { title: 'A', summary: 'old summary' }, { pinnedFields: ['summary'] });
    const b = await insertItem(SITE, { title: 'B' });
    const gone = await insertItem(SITE, { title: 'C', summary: 'deleted' }, { deletedAt: new Date() });
    const other = await insertItem(OTHER, { title: 'X', summary: 'other site' });

    await schemaOf(SITE).renameField('posts', 'summary', { name: 'excerpt', ...FIELD, confirmRiskyChange: true });

    const detail = await itemsOf(SITE).detail('posts', a.id);
    expect(detail.data).toMatchObject({ title: 'A', excerpt: 'old summary' });
    expect(detail.data).not.toHaveProperty('summary');

    const after = new Map((await rowsOf(SITE)).map((r) => [r.id, r]));
    expect(after.get(a.id)!.data).toEqual({ title: 'A', excerpt: 'old summary' });
    expect(after.get(a.id)!.version).toBe(a.version + 1);
    expect(after.get(a.id)!.pinnedFields).toEqual(['excerpt']);
    // An item without the key is not rewritten.
    expect(after.get(b.id)!.data).toEqual({ title: 'B' });
    expect(after.get(b.id)!.version).toBe(b.version);
    // Soft-deleted items move too, so a restore reads under the current name.
    expect(after.get(gone.id)!.data).toEqual({ title: 'C', excerpt: 'deleted' });

    const [otherRow] = await rowsOf(OTHER);
    expect(otherRow!.data).toEqual({ title: 'X', summary: 'other site' });
    expect(otherRow!.version).toBe(other.version);
    expect((await schemaOf(OTHER).listFields('posts')).map((f) => f.name)).toContain('summary');
  });

  it('updateField with a new name and updateSchema with renameFrom move the data too', async () => {
    const item = await insertItem(SITE, { title: 'A', summary: 's' });

    await schemaOf(SITE).updateField('posts', 'summary', { name: 'lede', confirmRiskyChange: true });
    let [row] = await rowsOf(SITE);
    expect(row!.data).toEqual({ title: 'A', lede: 's' });

    await schemaOf(SITE).updateSchema('posts', {
      fields: [
        { name: 'title', ...FIELD },
        { name: 'excerpt', ...FIELD, renameFrom: 'lede', confirmRiskyChange: true },
        { name: 'secret', ...FIELD, encrypted: true },
      ],
    });
    [row] = await rowsOf(SITE);
    expect(row!.id).toBe(item.id);
    expect(row!.data).toEqual({ title: 'A', excerpt: 's' });
    expect(row!.version).toBe(item.version + 2);
    expect((await schemaOf(SITE).listFields('posts')).map((f) => f.name).sort()).toEqual(['excerpt', 'secret', 'title']);
  });

  it('a populated rename without a plan or confirmation is refused and moves nothing', async () => {
    await insertItem(SITE, { title: 'A', summary: 's' });
    await expect(schemaOf(SITE).renameField('posts', 'summary', { name: 'excerpt', ...FIELD })).rejects.toMatchObject({
      code: 'FIELD_MIGRATION_REQUIRED',
    });
    const [row] = await rowsOf(SITE);
    expect(row!.data).toEqual({ title: 'A', summary: 's' });
  });

  it('refuses renaming a populated encrypted field (the name is in the AAD); an empty one renames', async () => {
    const opts = { ...FIELD, encrypted: true, confirmRiskyChange: true };
    await schemaOf(SITE).renameField('posts', 'secret', { name: 'token', ...opts });
    expect((await schemaOf(SITE).listFields('posts')).map((f) => f.name)).toContain('token');

    await insertItem(SITE, { title: 'A', token: 'enc:v1:ciphertext' }, { deletedAt: new Date() });
    const err = await schemaOf(SITE)
      .renameField('posts', 'token', { name: 'api_token', ...opts })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaServiceError);
    expect(err).toMatchObject({ code: 'ENCRYPTED_FIELD_RENAME_UNSUPPORTED', status: 409 });
    expect((await schemaOf(SITE).listFields('posts')).map((f) => f.name)).toContain('token');
    const [row] = await rowsOf(SITE);
    expect(row!.data).toEqual({ title: 'A', token: 'enc:v1:ciphertext' });
  });
});
