import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, fields, items, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { buildJsonPathIndexAdvice, castExpression } from '../json-filter-cast';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed tests for the type-aware Cast_Rule (json-field-search Req 4, #729).
 * Without casts, `data->>'price'` is text and `'10' > '9'` is false.
 *
 * **Validates: Requirements 4.1-4.5, 9 (typed sort)**
 */

const SITE = 'site_jsoncast_it';
const COLLECTION = 'products';

describe.skipIf(!hasDbIntegrationUrl)('JSON field Cast_Rule — DB integration', () => {
  let db: Database;
  let svc: ItemService;
  let collId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('json-field-cast');
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
      name: 'JSON Cast IT',
    });
    collId = (await db.insert(collections).values({ siteId: SITE, name: COLLECTION, label: 'Products' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'sku', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'price', type: 'decimal', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'in_stock', type: 'boolean', interface: 'boolean' },
      { siteId: SITE, collectionId: collId, name: 'launched_at', type: 'datetime', interface: 'datetime' },
      { siteId: SITE, collectionId: collId, name: 'metadata', type: 'json', interface: 'input' },
    ]);
    svc = new ItemService({ db, siteId: SITE });
    await svc.create(COLLECTION, { data: { title: 'A', sku: '9', price: 9, in_stock: true, launched_at: '2026-01-05T00:00:00.000Z', metadata: { rating: 4.5, promo: true } } });
    await svc.create(COLLECTION, { data: { title: 'B', sku: '10', price: 10, in_stock: false, launched_at: '2026-03-01T12:00:00.000Z', metadata: { rating: 10, promo: false } } });
    await svc.create(COLLECTION, { data: { title: 'C', sku: '100', price: 100.5, in_stock: true, launched_at: '2025-12-31T23:00:00.000Z', metadata: { rating: 2 } } });
  });

  async function titles(filter: unknown, sort?: string[]): Promise<string[]> {
    const res = (await svc.list(COLLECTION, { filter: filter as never, sort })) as unknown as {
      data: Array<{ data: { title: string } }>;
    };
    return res.data.map((r) => r.data.title);
  }
  const sorted = async (filter: unknown) => (await titles(filter)).sort();

  it('compares a decimal field numerically, not lexicographically (Req 4.2)', async () => {
    expect(await sorted({ price: { _gt: 9 } })).toEqual(['B', 'C']);
    expect(await sorted({ price: { _gte: 10, _lt: 100 } })).toEqual(['B']);
    // A numeric string value is accepted for a numeric field.
    expect(await sorted({ price: { _lte: '10' } })).toEqual(['A', 'B']);
    expect(await sorted({ price: { _eq: 100.5 } })).toEqual(['C']);
    expect(await sorted({ price: { _in: [9, 100.5] } })).toEqual(['A', 'C']);
    expect(await sorted({ price: { _nin: [9] } })).toEqual(['B', 'C']);
  });

  it('casts booleans (Req 4.2)', async () => {
    expect(await sorted({ in_stock: { _eq: true } })).toEqual(['A', 'C']);
    expect(await sorted({ in_stock: { _eq: 'false' } })).toEqual(['B']);
  });

  it('compares datetimes as timestamps (Req 4.2)', async () => {
    expect(await sorted({ launched_at: { _gte: '2026-01-01' } })).toEqual(['A', 'B']);
    expect(await sorted({ launched_at: { _lt: '2026-01-01T07:00:00+07:00' } })).toEqual(['C']);
  });

  it('keeps string fields as text even with a numeric-looking value (Req 4.5)', async () => {
    // Lexicographic: '9' > '10' and '100' > '10', unlike numeric order.
    expect(await sorted({ sku: { _gt: '10' } })).toEqual(['A', 'C']);
    expect(await sorted({ sku: { _eq: '10' } })).toEqual(['B']);
  });

  it('infers numeric/boolean casts from the value on nested JSON paths', async () => {
    expect(await sorted({ 'metadata.rating': { _gt: 4 } })).toEqual(['A', 'B']);
    expect(await sorted({ 'metadata.promo': { _eq: true } })).toEqual(['A']);
  });

  it('does not fail the query when a stored value does not match the type (Req 4.4)', async () => {
    await svc.create(COLLECTION, { data: { title: 'D', price: 'n/a', in_stock: 'maybe', launched_at: 'soon' } }).catch(async () => {
      // Field validation may reject the malformed write; insert raw to simulate legacy data.
      await db.insert(items).values({
        siteId: SITE,
        collectionId: collId,
        status: 'draft',
        data: { title: 'D', price: 'n/a', in_stock: 'maybe', launched_at: 'soon' },
      });
    });
    expect(await sorted({ price: { _gt: 0 } })).toEqual(['A', 'B', 'C']);
    expect(await sorted({ in_stock: { _eq: false } })).toEqual(['B']);
    expect(await sorted({ launched_at: { _gt: '2000-01-01' } })).toEqual(['A', 'B', 'C']);
  });

  it('rejects a filter value that cannot be cast with INVALID_FILTER, not a DB error', async () => {
    await expect(titles({ price: { _gt: 'cheap' } })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    await expect(titles({ in_stock: { _eq: 'yes' } })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    await expect(titles({ launched_at: { _gt: 'not a date' } })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('sorts a numeric field numerically (Req 9)', async () => {
    expect(await titles(undefined, ['price'])).toEqual(['A', 'B', 'C']);
    expect(await titles(undefined, ['-price'])).toEqual(['C', 'B', 'A']);
  });

  it('string operators stay text on numeric fields', async () => {
    expect(await sorted({ price: { _starts_with: '10' } })).toEqual(['B', 'C']);
  });

  it('uses the advised expression index for a numeric JSON path filter (#729)', async () => {
    const advice = buildJsonPathIndexAdvice({ collectionId: collId, collectionName: COLLECTION, segments: ['price'], cast: 'numeric' });
    expect(advice.ddl).toContain('CREATE INDEX CONCURRENTLY');
    try {
      await db.execute(sql.raw(advice.ddl!));
      await db.execute(sql`ANALYZE lumibase_items`);
      // Same expression the filter builder emits (key bound as a parameter).
      const expr = castExpression(sql`${items.data}->>${'price'}`, 'numeric');
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        return tx.execute(
          sql`EXPLAIN SELECT id FROM lumibase_items WHERE collection_id = ${collId} AND deleted_at IS NULL AND ${expr} > ${'10'}::numeric`,
        );
      });
      const text = (plan as unknown as Array<Record<string, string>>).map((r) => Object.values(r)[0]).join('\n');
      expect(text).toContain(advice.indexName);
    } finally {
      await db.execute(sql.raw(`DROP INDEX IF EXISTS ${advice.indexName}`));
    }
  });

  it('uses the advised index for a nested numeric path too', async () => {
    const advice = buildJsonPathIndexAdvice({ collectionId: collId, collectionName: COLLECTION, segments: ['metadata', 'rating'], cast: 'numeric' });
    try {
      await db.execute(sql.raw(advice.ddl!));
      await db.execute(sql`ANALYZE lumibase_items`);
      const expr = castExpression(sql`${items.data}#>>${'{metadata,rating}'}::text[]`, 'numeric');
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        return tx.execute(
          sql`EXPLAIN SELECT id FROM lumibase_items WHERE collection_id = ${collId} AND deleted_at IS NULL AND ${expr} > ${'4'}::numeric`,
        );
      });
      const text = (plan as unknown as Array<Record<string, string>>).map((r) => Object.values(r)[0]).join('\n');
      expect(text).toContain(advice.indexName);
    } finally {
      await db.execute(sql.raw(`DROP INDEX IF EXISTS ${advice.indexName}`));
    }
  });
});
