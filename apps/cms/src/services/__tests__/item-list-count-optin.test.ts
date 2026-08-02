import { describe, expect, it } from 'vitest';
import type { CacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { ItemService } from '../item-service';

/**
 * Count opt-in on the items list (high-load-cache-readiness Req 5; design
 * §6.1, §15.2). Verifies the `count(*)` aggregate only runs when a total is
 * wanted, and that `meta.total` is present/absent accordingly.
 *
 * A fake DB replays fixed result sets and records whether the count query
 * (the only `select()` invoked WITH a projection argument) ran. A fake cache
 * pre-seeded with a compiled schema bundle keeps `SchemaService.getCompiled`
 * off the DB so the harness stays minimal.
 */

const COLLECTION = { id: 'col_posts', siteId: 'site-1', name: 'posts', system: false };
const ITEM_ROWS = [
  { id: 'it_1', siteId: 'site-1', collectionId: 'col_posts', status: 'published', sort: 0, data: {}, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
];

function fakeDb() {
  let countQueries = 0;
  const db = {
    select(projection?: unknown) {
      const isCount = projection !== undefined;
      if (isCount) countQueries += 1;
      const builder: Record<string, unknown> = {
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        offset: () => builder,
        then: (onF?: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) => {
          // count query → [{ count }]; everything else → item rows.
          // Collection resolution now goes through SchemaService.getCompiled
          // (cache), so there is no collection select on the list path.
          const value = isCount ? [{ count: 99 }] : ITEM_ROWS;
          return Promise.resolve(value as unknown[]).then(onF, onR);
        },
      };
      return builder;
    },
    countQueries: () => countQueries,
  };
  return db;
}

function fakeCache(): CacheProvider {
  const store = new Map<string, string>();
  store.set(
    'schema:site-1:posts',
    JSON.stringify({
      id: 'col_posts',
      name: 'posts',
      primaryKeyField: 'id',
      primaryKeyType: 'nanoid',
      storageMode: 'jsonb',
      fields: [{ name: 'title' }],
    }),
  );
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async increment(key: string, by = 1) {
      const next = Number(store.get(key) ?? '0') + by;
      store.set(key, String(next));
      return next;
    },
    async getEntry<T>(key: string) {
      const raw = store.get(key);
      if (raw === undefined) return { state: 'miss' as const };
      return { state: 'hit' as const, value: JSON.parse(raw) as T };
    },
    async setNegative(key: string) {
      store.set(key, JSON.stringify({ __lumi: 'neg', v: 1 }));
    },
    async invalidateByTag() {
      // not used
    },
  };
}

function service(db: ReturnType<typeof fakeDb>) {
  return new ItemService({
    db: db as unknown as Database,
    cache: fakeCache(),
    siteId: 'site-1',
  });
}

describe('ItemService.list — count opt-in', () => {
  it('runs count(*) and returns meta.total by default', async () => {
    const db = fakeDb();
    const result = await service(db).list('posts');
    expect(db.countQueries()).toBe(1);
    expect(result.meta).toEqual({ total: 99, limit: 25, offset: 0 });
  });

  it('runs count(*) when withTotal is explicitly true', async () => {
    const db = fakeDb();
    const result = await service(db).list('posts', { withTotal: true });
    expect(db.countQueries()).toBe(1);
    expect(result.meta).toHaveProperty('total', 99);
  });

  it('skips count(*) and omits meta.total when withTotal is false (Req 5.3)', async () => {
    const db = fakeDb();
    const result = await service(db).list('posts', { withTotal: false });
    expect(db.countQueries()).toBe(0);
    expect(result.meta).toEqual({ limit: 25, offset: 0 });
    expect(result.meta).not.toHaveProperty('total');
  });
});
