import { describe, it, expect } from 'vitest';
import { sweepDuePublish, sweepDueUnpublish, runSchedulerTick } from '../scheduler-worker';
import { items, collections, settings } from '@lumibase/database';
import type { Database } from '@lumibase/database';

/**
 * Mock drizzle surface keyed by table. Select chains resolve to canned rows;
 * updates are recorded with their guard so idempotency can be asserted.
 */
function makeDb(rowsByTable: Map<unknown, Record<string, unknown>[]>) {
  const updates: { set: Record<string, unknown> }[] = [];
  const db = {
    select() {
      let table: unknown;
      const builder: Record<string, unknown> = {
        from(t: unknown) {
          table = t;
          return builder;
        },
        where() {
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit() {
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
        },
      };
      return builder;
    },
    update() {
      return {
        set(set: Record<string, unknown>) {
          updates.push({ set });
          return { where: () => Promise.resolve(undefined) };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates };
}

const now = new Date('2026-06-17T12:00:00.000Z');
const past = new Date('2026-06-17T11:00:00.000Z');

describe('scheduler sweepDuePublish (Req 7.3)', () => {
  it('publishes due scheduled items and sets editorial_state', async () => {
    const { db, updates } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [items, [{ id: 'i1', siteId: 's1', collectionId: 'c1', publishAt: past }]],
        [collections, [{ id: 'c1', name: 'posts' }]],
        [settings, []],
      ]),
    );
    const n = await sweepDuePublish({ db }, now);
    expect(n).toBe(1);
    expect(updates[0]?.set).toMatchObject({ status: 'published', editorialState: 'published' });
  });

  it('is a no-op when nothing is due', async () => {
    const { db, updates } = makeDb(new Map([[items, []]]));
    expect(await sweepDuePublish({ db }, now)).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe('scheduler sweepDueUnpublish (Req 7.4)', () => {
  it('archives published items past their unpublish window by default', async () => {
    const { db, updates } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [items, [{ id: 'i1', siteId: 's1', collectionId: 'c1', unpublishAt: past }]],
        [collections, [{ id: 'c1', name: 'posts', meta: {} }]],
        [settings, []],
      ]),
    );
    const n = await sweepDueUnpublish({ db }, now);
    expect(n).toBe(1);
    expect(updates.some((u) => u.set.status === 'archived')).toBe(true);
  });

  it('honours unpublishTarget=draft', async () => {
    const { db, updates } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [items, [{ id: 'i1', siteId: 's1', collectionId: 'c1', unpublishAt: past }]],
        [collections, [{ id: 'c1', name: 'posts', meta: { unpublishTarget: 'draft' } }]],
        [settings, []],
      ]),
    );
    await sweepDueUnpublish({ db }, now);
    expect(updates.some((u) => u.set.status === 'draft' && u.set.editorialState === 'draft')).toBe(true);
  });
});

describe('runSchedulerTick', () => {
  it('returns published + unpublished + release + flow counts', async () => {
    const { db } = makeDb(new Map([[items, []]]));
    expect(await runSchedulerTick({ db }, now)).toEqual({
      published: 0,
      unpublished: 0,
      releasesPublished: 0,
      flowsEnqueued: 0,
    });
  });
});
