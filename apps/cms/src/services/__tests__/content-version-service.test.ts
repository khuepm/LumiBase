import type { Database } from '@lumibase/database';
import { diffFields } from '@lumibase/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ContentVersionError,
  ContentVersionService,
  hashData,
  type ItemAccess,
} from '../content-version-service';

// ── diffFields (shared) ──────────────────────────────────────────────────────

describe('diffFields', () => {
  it('classifies added / removed / changed / unchanged', () => {
    const changes = diffFields({ a: 1, b: 2, d: 4 }, { a: 1, b: 3, c: 5 });
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c.state]));
    expect(byKey).toEqual({ a: 'unchanged', b: 'changed', c: 'added', d: 'removed' });
  });
});

// ── hashData ─────────────────────────────────────────────────────────────────

describe('hashData', () => {
  it('is stable regardless of key order', () => {
    expect(hashData({ a: 1, b: 2 })).toBe(hashData({ b: 2, a: 1 }));
  });
  it('changes when a value changes', () => {
    expect(hashData({ a: 1 })).not.toBe(hashData({ a: 2 }));
  });
});

// ── service ──────────────────────────────────────────────────────────────────

const COLL = { id: 'coll_1' };

interface DbOpts {
  versionRows?: Record<string, unknown>[]; // result of version SELECT
  inserted?: Record<string, unknown>[];
  updated?: Record<string, unknown>[];
  deleted?: { id: string }[];
}

function fakeDb(opts: DbOpts): { db: Database; captured: { insertValues?: Record<string, unknown> } } {
  const captured: { insertValues?: Record<string, unknown> } = {};
  // The collection lookup uses `.select({ id: ... })` (projection arg present);
  // version queries use `.select()` (no arg). Disambiguate on that, not call
  // order, so nested lookups resolve to the right table.
  const collChain = {
    from: () => collChain,
    where: () => collChain,
    limit: () => Promise.resolve([COLL]),
  };
  const versionChain = {
    from: () => versionChain,
    where: () => versionChain,
    limit: () => Promise.resolve(opts.versionRows ?? []),
    then: (res: (v: unknown) => void) => res(opts.versionRows ?? []),
  };
  const insertChain = {
    values: (v: Record<string, unknown>) => {
      captured.insertValues = v;
      return insertChain;
    },
    returning: () => Promise.resolve(opts.inserted ?? [{ id: 'v1', ...captured.insertValues }]),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(opts.updated ?? []),
  };
  const deleteChain = {
    where: () => deleteChain,
    returning: () => Promise.resolve(opts.deleted ?? []),
  };
  const db = {
    select: (projection?: unknown) => (projection ? collChain : versionChain),
    insert: () => insertChain,
    update: () => updateChain,
    delete: () => deleteChain,
  } as unknown as Database;
  return { db, captured };
}

function fakeItems(mainData: Record<string, unknown>): ItemAccess & { patch: ReturnType<typeof vi.fn> } {
  return {
    detail: async () => ({ data: mainData }),
    patch: vi.fn(async () => ({ id: 'item_1', data: mainData })),
  };
}

describe('ContentVersionService', () => {
  it('create snapshots current main data + hash', async () => {
    const { db, captured } = fakeDb({ versionRows: [] });
    const items = fakeItems({ title: 'Live' });
    const svc = new ContentVersionService({ db, siteId: 's1', userId: 'u1', items });
    await svc.create('posts', 'item_1', 'draft', 'Draft');
    expect(captured.insertValues?.data).toEqual({ title: 'Live' });
    expect(captured.insertValues?.hash).toBe(hashData({ title: 'Live' }));
    expect(captured.insertValues?.key).toBe('draft');
  });

  it('create 409s when the key already exists', async () => {
    const { db } = fakeDb({ versionRows: [{ id: 'v1', key: 'draft', data: {}, hash: 'x' }] });
    const svc = new ContentVersionService({ db, siteId: 's1', userId: null, items: fakeItems({}) });
    await expect(svc.create('posts', 'item_1', 'draft', 'Draft')).rejects.toMatchObject({ code: 'VERSION_EXISTS', status: 409 });
  });

  it('list flags mainChanged when main has diverged from the snapshot', async () => {
    const stale = { id: 'v1', siteId: 's1', itemId: 'item_1', collectionId: 'coll_1', key: 'draft', name: 'D', data: {}, hash: 'deadbeef', createdBy: null, createdAt: new Date(), updatedAt: new Date() };
    const { db } = fakeDb({ versionRows: [stale] });
    const svc = new ContentVersionService({ db, siteId: 's1', userId: null, items: fakeItems({ title: 'Changed' }) });
    const rows = await svc.list('posts', 'item_1');
    expect(rows[0]?.mainChanged).toBe(true);
  });

  it('compare returns field changes between main and version', async () => {
    const version = { id: 'v1', siteId: 's1', itemId: 'item_1', collectionId: 'coll_1', key: 'draft', name: 'D', data: { title: 'New' }, hash: 'x', createdBy: null, createdAt: new Date(), updatedAt: new Date() };
    const { db } = fakeDb({ versionRows: [version] });
    const svc = new ContentVersionService({ db, siteId: 's1', userId: null, items: fakeItems({ title: 'Old' }) });
    const cmp = await svc.compare('posts', 'item_1', 'draft');
    expect(cmp.changes.find((c) => c.key === 'title')?.state).toBe('changed');
  });

  it('promote applies version data via ItemService.patch then removes the version', async () => {
    const version = { id: 'v1', siteId: 's1', itemId: 'item_1', collectionId: 'coll_1', key: 'draft', name: 'D', data: { title: 'Promoted' }, hash: hashData({ title: 'Live' }), createdBy: null, createdAt: new Date(), updatedAt: new Date() };
    // get() → version; remove() → deleted one row
    const { db } = fakeDb({ versionRows: [version], deleted: [{ id: 'v1' }] });
    const items = fakeItems({ title: 'Live' });
    const svc = new ContentVersionService({ db, siteId: 's1', userId: null, items });
    const { mainDiverged } = await svc.promote('posts', 'item_1', 'draft');
    expect(items.patch).toHaveBeenCalledWith('posts', 'item_1', { data: { title: 'Promoted' } });
    expect(mainDiverged).toBe(false); // snapshot hash matches current main
  });
});
