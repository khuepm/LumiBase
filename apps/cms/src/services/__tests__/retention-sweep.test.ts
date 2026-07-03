import { describe, it, expect, vi } from 'vitest';
import { sweepRetention } from '../scheduler-worker';
import { collections, items, settings } from '@lumibase/database';
import type { Database } from '@lumibase/database';

// ItemService is constructed inside sweepRetention; stub hardDelete/cryptoShred.
vi.mock('../item-service', () => ({
  ItemService: vi.fn().mockImplementation(() => ({
    hardDelete: vi.fn().mockResolvedValue(true),
    cryptoShred: vi.fn().mockResolvedValue(true),
  })),
}));

function makeDb(rowsByTable: Map<unknown, Record<string, unknown>[]>) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select() {
      let table: unknown;
      const b: Record<string, unknown> = {
        from(t: unknown) { table = t; return b; },
        where() { return b; },
        orderBy() { return b; },
        limit() { return Promise.resolve(rowsByTable.get(table) ?? []); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
        },
      };
      return b;
    },
    insert() {
      return { values: () => ({ returning: () => Promise.resolve([{}]), then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r) }) };
    },
    update() {
      return { set(s: Record<string, unknown>) { updates.push(s); return { where: () => ({ returning: () => Promise.resolve([{ id: 'x' }]) }) }; } };
    },
  };
  return { db: db as unknown as Database, updates };
}

describe('sweepRetention (Req 12)', () => {
  it('archives items older than maxAgeDays', async () => {
    const { db, updates } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [settings, [{ siteId: 's1', value: { policies: [{ collection: 'logs', maxAgeDays: 30, action: 'archive' }] } }]],
        [collections, [{ id: 'c1', name: 'logs' }]],
        [items, [{ id: 'i1' }, { id: 'i2' }]],
      ]),
    );
    const applied = await sweepRetention({ db }, new Date('2026-06-17T00:00:00Z'));
    expect(applied).toBe(2);
    expect(updates.every((u) => u.status === 'archived')).toBe(true);
  });

  it('ignores sites with no/invalid policies', async () => {
    const { db } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [settings, [{ siteId: 's1', value: { policies: [] } }]],
      ]),
    );
    expect(await sweepRetention({ db })).toBe(0);
  });

  it('skips a policy whose collection is missing', async () => {
    const { db } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [settings, [{ siteId: 's1', value: [{ collection: 'gone', maxAgeDays: 1, action: 'hard_delete' }] }]],
        [collections, []],
      ]),
    );
    expect(await sweepRetention({ db })).toBe(0);
  });
});
