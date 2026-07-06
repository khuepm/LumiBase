import type { Database } from '@lumibase/database';
import { describe, expect, it, vi } from 'vitest';
import { dispatchItemEvent, findActiveEventFlows } from '../flow-dispatch';

function fakeDb(rows: { id: string; triggerOptions: unknown }[]) {
  const chain = { from: () => chain, where: () => Promise.resolve(rows) };
  return { select: () => chain } as unknown as Database;
}

describe('findActiveEventFlows', () => {
  it('matches on collection + action, and treats absent actions as all', async () => {
    const db = fakeDb([
      { id: 'f_all', triggerOptions: { collection: 'posts' } },
      { id: 'f_create', triggerOptions: { collection: 'posts', actions: ['create'] } },
      { id: 'f_other', triggerOptions: { collection: 'pages' } },
    ]);
    const create = await findActiveEventFlows(db, 's1', 'posts', 'create');
    expect(create.map((f) => f.id).sort()).toEqual(['f_all', 'f_create']);

    const update = await findActiveEventFlows(db, 's1', 'posts', 'update');
    expect(update.map((f) => f.id)).toEqual(['f_all']);
  });
});

describe('dispatchItemEvent', () => {
  it('enqueues one job per matched flow, non-blocking', async () => {
    const db = fakeDb([{ id: 'f1', triggerOptions: { collection: 'posts' } }]);
    const enqueue = vi.fn(async () => 'job-1');
    const queue = { enqueue, process: vi.fn(), getStatus: vi.fn() } as never;
    const n = await dispatchItemEvent(
      { db, queue },
      { siteId: 's1', collection: 'posts', action: 'create', itemId: 'i1', payload: { a: 1 } },
    );
    expect(n).toBe(1);
    expect(enqueue).toHaveBeenCalledWith('flow-events', 'run-event-flow', expect.objectContaining({ flowId: 'f1' }));
  });

  it('is a no-op without a queue', async () => {
    const db = fakeDb([{ id: 'f1', triggerOptions: {} }]);
    const n = await dispatchItemEvent({ db }, { siteId: 's1', collection: 'posts', action: 'create', itemId: 'i1', payload: {} });
    expect(n).toBe(0);
  });

  it('swallows enqueue errors so mutations are never blocked', async () => {
    const db = fakeDb([{ id: 'f1', triggerOptions: {} }]);
    const queue = { enqueue: vi.fn(async () => { throw new Error('down'); }), process: vi.fn(), getStatus: vi.fn() } as never;
    const n = await dispatchItemEvent({ db, queue }, { siteId: 's1', collection: 'posts', action: 'update', itemId: 'i1', payload: {} });
    expect(n).toBe(0);
  });
});
