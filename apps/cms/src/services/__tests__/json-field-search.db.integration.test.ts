import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, createDb, fields, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';

/**
 * DB-backed tests for JSON field search (json-field-search Req 1, 2, 3, 7).
 * Filters into nested JSONB and uses containment / key-existence operators on
 * real Postgres. Skips without DATABASE_URL.
 *
 * **Validates: Requirements 1 (dot-path), 3 (json ops), 7 (backward compat)**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_jsonsearch_it';
const COLLECTION = 'products';

describe('JSON field search — DB integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping json-field-search DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping json-field-search DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  let svc: ItemService;

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'JSON Search IT' });
    const collId = (await db.insert(collections).values({ siteId: SITE, name: COLLECTION, label: 'Products' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'metadata', type: 'json', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'tags', type: 'json', interface: 'input' },
    ]);
    svc = new ItemService({ db, siteId: SITE });
    await svc.create(COLLECTION, { data: { title: 'A', metadata: { author: { country: 'VN' }, featured: true }, tags: ['sale', 'new'] } });
    await svc.create(COLLECTION, { data: { title: 'B', metadata: { author: { country: 'US' }, featured: false }, tags: ['clearance'] } });
    await svc.create(COLLECTION, { data: { title: 'C', metadata: { author: { country: 'VN' } }, tags: ['new'] } });
  });

  async function titles(filter: unknown): Promise<string[]> {
    const res = (await svc.list(COLLECTION, { filter: filter as never })) as unknown as { data: Array<{ data: { title: string } }> };
    return res.data.map((r) => r.data.title).sort();
  }

  it('filters by a nested dot-path (Req 1)', async () => {
    if (!canConnect) return;
    expect(await titles({ 'metadata.author.country': { _eq: 'VN' } })).toEqual(['A', 'C']);
    expect(await titles({ 'metadata.author.country': { _eq: 'US' } })).toEqual(['B']);
  });

  it('still supports top-level keys unchanged (Req 7)', async () => {
    if (!canConnect) return;
    expect(await titles({ title: { _eq: 'A' } })).toEqual(['A']);
  });

  it('_json_contains matches a nested sub-object (Req 3)', async () => {
    if (!canConnect) return;
    expect(await titles({ metadata: { _json_contains: { author: { country: 'VN' } } } })).toEqual(['A', 'C']);
  });

  it('_has_key checks key existence in a JSON object (Req 3)', async () => {
    if (!canConnect) return;
    // Only A and B have metadata.featured.
    expect(await titles({ metadata: { _has_key: 'featured' } })).toEqual(['A', 'B']);
  });

  it('_json_contains matches an array membership on tags (Req 3)', async () => {
    if (!canConnect) return;
    expect(await titles({ tags: { _json_contains: ['new'] } })).toEqual(['A', 'C']);
  });

  it('_has_any_keys / _has_all_keys check multiple keys (Req 3)', async () => {
    if (!canConnect) return;
    // metadata of A,B has author+featured; C has only author.
    expect(await titles({ metadata: { _has_any_keys: ['featured', 'missing'] } })).toEqual(['A', 'B']);
    expect(await titles({ metadata: { _has_all_keys: ['author', 'featured'] } })).toEqual(['A', 'B']);
    expect(await titles({ metadata: { _has_all_keys: ['author'] } })).toEqual(['A', 'B', 'C']);
  });

  it('rejects an injection attempt in the path (Req 6)', async () => {
    if (!canConnect) return;
    await expect(titles({ "metadata->>'x';drop table items;--": { _eq: 'x' } })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });
});
