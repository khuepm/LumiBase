/**
 * Pages CRUD + B16 forgetNegative wiring
 * (high-load-cache-readiness task 22.6 / backlog B16).
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { activity } from '@lumibase/database';
import { PAGE_ACTIVITY_COLLECTION, PageService, PageServiceError, snapshot, unpublishedSourceIssues } from '../page-service';
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

type ActivityRow = Record<string, unknown>;

function makeDb(store: { rows: PageRow[]; activity?: ActivityRow[] }) {
  const db = {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
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
    insert: (table: unknown) => ({
      values: (input: Omit<PageRow, 'createdAt' | 'updatedAt'> & Partial<PageRow>) => table === activity
        ? Promise.resolve(void (store.activity ??= []).push(input as unknown as ActivityRow))
        : {
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
      },
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
  return db;
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

describe('unpublishedSourceIssues (#1006)', () => {
  it('flags every section source whose status is not published, with its path', () => {
    const issues = unpublishedSourceIssues({
      sections: [
        { id: 'a', component: 'list', source: { collection: 'posts' } },
        { id: 'b', component: 'list', source: { collection: 'posts', status: 'published' } },
        { id: 'c', component: 'list', source: { collection: 'posts', status: 'draft' } },
        { id: 'd', component: 'list', source: { collection: 'posts', status: null } },
        { id: 'e', component: 'hero' },
        'not a section',
      ],
    });
    expect(issues.map((i) => i.field)).toEqual(['sections.2.source.status', 'sections.3.source.status']);
    expect(issues.every((i) => i.code === 'VALIDATION')).toBe(true);
  });

  it('accepts layouts without sections or sources', () => {
    expect(unpublishedSourceIssues(undefined)).toEqual([]);
    expect(unpublishedSourceIssues({ sections: 'x' })).toEqual([]);
    expect(unpublishedSourceIssues({ version: 1, sections: [] })).toEqual([]);
  });
});

describe('PageService activity trail (#986)', () => {
  const base = (): PageRow => ({
    id: 'pg_1',
    siteId: 'site-a',
    slug: 'home',
    title: 'Home',
    layoutConfig: { sections: [{ id: 's1', kind: 'hero' }] },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('records create with the actor and an after snapshot', async () => {
    const store = { rows: [] as PageRow[], activity: [] as ActivityRow[] };
    const svc = new PageService({ db: makeDb(store) as never, siteId: 'site-a', actorId: 'usr_1' });
    const row = await svc.create({ slug: 'home', title: 'Home', layoutConfig: { b: 1, a: 2 } });
    expect(store.activity).toHaveLength(1);
    expect(store.activity[0]).toMatchObject({
      siteId: 'site-a',
      action: 'create',
      userId: 'usr_1',
      collection: PAGE_ACTIVITY_COLLECTION,
      itemId: row.id,
      payload: { after: { slug: 'home', title: 'Home', layoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } },
    });
  });

  it('records update with before and after, so a layout swap is visible', async () => {
    const store = { rows: [base()], activity: [] as ActivityRow[] };
    const before = await snapshot(base());
    const svc = new PageService({ db: makeDb(store) as never, siteId: 'site-a', actorId: 'usr_2' });
    await svc.patch('pg_1', { layoutConfig: { sections: [{ id: 's1', kind: 'download', href: 'https://x.test/a.zip' }] } });
    const entry = store.activity[0] as { action: string; userId: string; payload: { before: { layoutSha256: string }; after: { layoutSha256: string } } };
    expect(entry.action).toBe('update');
    expect(entry.userId).toBe('usr_2');
    expect(entry.payload.before).toEqual(before);
    expect(entry.payload.after.layoutSha256).not.toBe(before.layoutSha256);
  });

  it('records delete with a before snapshot', async () => {
    const store = { rows: [base()], activity: [] as ActivityRow[] };
    const svc = new PageService({ db: makeDb(store) as never, siteId: 'site-a' });
    await svc.delete('pg_1');
    expect(store.activity[0]).toMatchObject({ action: 'delete', userId: null, itemId: 'pg_1', payload: { before: { slug: 'home' } } });
  });

  it('hashes layouts canonically: key order does not change the hash', async () => {
    const a = await snapshot({ slug: 's', title: 't', layoutConfig: { a: 1, b: { c: 2, d: 3 } } });
    const b = await snapshot({ slug: 's', title: 't', layoutConfig: { b: { d: 3, c: 2 }, a: 1 } });
    expect(a.layoutSha256).toBe(b.layoutSha256);
  });
});
