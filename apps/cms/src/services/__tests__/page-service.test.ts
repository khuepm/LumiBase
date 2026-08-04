/**
 * Pages CRUD + B16 forgetNegative wiring
 * (high-load-cache-readiness task 22.6 / backlog B16).
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { PageService, PageServiceError } from '../page-service';
import { negativePageKey } from '../negative-cache';

type PageRow = {
  id: string;
  siteId: string;
  slug: string;
  title: string;
  layoutConfig: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

function makeDb(store: { rows: PageRow[] }) {
  return {
    select: () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => Promise.resolve(store.rows.slice(0, 1)),
        then: (
          onFulfilled?: (value: PageRow[]) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(store.rows).then(onFulfilled, onRejected),
      };
      return builder;
    },
    insert: () => ({
      values: (input: Omit<PageRow, 'createdAt' | 'updatedAt'> & Partial<PageRow>) => ({
        returning: async () => {
          const row: PageRow = {
            id: input.id,
            siteId: input.siteId,
            slug: input.slug,
            title: input.title,
            layoutConfig: (input.layoutConfig as Record<string, unknown>) ?? {},
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          store.rows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<PageRow>) => ({
        where: () => ({
          returning: async () => {
            const row = store.rows[0];
            if (!row) return [];
            Object.assign(row, patch, { updatedAt: new Date() });
            return [row];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        store.rows.splice(0, store.rows.length);
      },
    }),
  };
}

describe('PageService forgetNegative (B16)', () => {
  it('forgets tombstone after create so deliver can see the page immediately', async () => {
    const cache = new MemoryCacheProvider();
    const siteId = 'site-a';
    const slug = 'home';
    await cache.setNegative(negativePageKey(siteId, slug), { ttl: 30 });
    expect((await cache.getEntry(negativePageKey(siteId, slug))).state).toBe('negative');

    const store = { rows: [] as PageRow[] };
    const svc = new PageService({
      db: makeDb(store) as never,
      siteId,
      cache,
    });

    const row = await svc.create({ slug, title: 'Home', layoutConfig: { sections: [] } });
    expect(row.slug).toBe(slug);
    expect((await cache.getEntry(negativePageKey(siteId, slug))).state).toBe('miss');
  });

  it('forgets both old and new slug tombstones on rename', async () => {
    const cache = new MemoryCacheProvider();
    const siteId = 'site-a';
    const existing: PageRow = {
      id: 'pg_1',
      siteId,
      slug: 'old-slug',
      title: 'Old',
      layoutConfig: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await cache.setNegative(negativePageKey(siteId, 'old-slug'), { ttl: 30 });
    await cache.setNegative(negativePageKey(siteId, 'new-slug'), { ttl: 30 });

    const store = { rows: [existing] };
    // getById uses select().limit(1) → first row; list uses then → all rows
    const db = makeDb(store);
    const svc = new PageService({ db: db as never, siteId, cache });

    const updated = await svc.patch('pg_1', { slug: 'new-slug' });
    expect(updated.slug).toBe('new-slug');
    expect((await cache.getEntry(negativePageKey(siteId, 'new-slug'))).state).toBe('miss');
    expect((await cache.getEntry(negativePageKey(siteId, 'old-slug'))).state).toBe('miss');
  });

  it('rejects invalid slug shape', async () => {
    const svc = new PageService({
      db: makeDb({ rows: [] }) as never,
      siteId: 'site-a',
      cache: new MemoryCacheProvider(),
    });
    await expect(svc.create({ slug: 'Bad Slug!', title: 'X' })).rejects.toBeInstanceOf(
      PageServiceError,
    );
  });

  it('does not fail create when cache forget throws', async () => {
    const cache = new MemoryCacheProvider();
    vi.spyOn(cache, 'delete').mockRejectedValueOnce(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = { rows: [] as PageRow[] };
    const svc = new PageService({
      db: makeDb(store) as never,
      siteId: 'site-a',
      cache,
    });

    const row = await svc.create({ slug: 'home', title: 'Home' });
    expect(row.slug).toBe('home');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
