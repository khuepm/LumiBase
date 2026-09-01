import { describe, it, expect, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import {
  FLOW_EVENTS_QUEUE,
  dispatchItemEvent,
  findActiveEventFlows,
  processFlowEventJob,
  type FlowEventJob,
} from '../flow-dispatch';

/**
 * Flow event trigger (visual-flow-builder task 3.4).
 *
 * **Validates: Requirements 1.1, 1.5, 7.3**
 */

/** Fake drizzle surface: selects resolve to canned flow rows; inserts/updates recorded. */
function makeDb(flowRows: Record<string, unknown>[]) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const db = {
    select() {
      const builder: Record<string, unknown> = {
        from: () => builder,
        where: () => Promise.resolve(flowRows),
      };
      return builder;
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: 'run_1', ...v }]) };
        },
      };
    },
    update() {
      return {
        set(set: Record<string, unknown>) {
          updates.push(set);
          return { where: () => Promise.resolve(undefined) };
        },
      };
    },
  };
  return { db: db as unknown as Database, inserted, updates };
}

import type { QueueProvider } from '@lumibase/runtime';

function makeQueue() {
  const enqueued: { queue: string; name: string; data: FlowEventJob }[] = [];
  const enqueue = vi.fn(async (queue: string, name: string, data: FlowEventJob) => {
    enqueued.push({ queue, name, data });
    return 'job_1';
  });
  const queue = { enqueue, process: vi.fn(), getStatus: vi.fn() } as unknown as QueueProvider;
  return { enqueued, enqueue, queue };
}

const EVENT = { collection: 'posts', action: 'create' as const, itemId: 'i1', payload: { title: 'x' } };

const flow = (id: string, triggerOptions: Record<string, unknown>, status = 'active') => ({
  id,
  siteId: 's1',
  status,
  triggerType: 'event',
  triggerOptions,
  graph: { entry: 'n1', nodes: [{ id: 'n1', key: 'log', options: { message: 'hi' } }] },
});

describe('findActiveEventFlows trigger matching (Req 1.1, 1.5)', () => {
  it('matches on collection + action and supports arrays', async () => {
    const { db } = makeDb([
      flow('f1', { collection: 'posts', action: 'create' }),
      flow('f2', { collection: ['posts', 'pages'], action: ['update', 'create'] }),
      flow('f3', { collection: 'pages' }), // other collection → no match
      flow('f4', { collection: 'posts', action: 'delete' }), // other action → no match
    ]);
    const matched = await findActiveEventFlows(db, 's1', 'posts', 'create');
    expect(matched.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('treats missing collection/action options as wildcard', async () => {
    const { db } = makeDb([flow('f1', {})]);
    const matched = await findActiveEventFlows(db, 's1', 'anything', 'delete');
    expect(matched.map((f) => f.id)).toEqual(['f1']);
  });
});

describe('dispatchItemEvent (Req 1.1, 7.3)', () => {
  it('enqueues one flow:event job per matching flow, carrying siteId', async () => {
    const { db } = makeDb([flow('f1', { collection: 'posts' }), flow('f2', { collection: 'pages' })]);
    const { queue, enqueued } = makeQueue();
    await dispatchItemEvent({ db, siteId: 's1', queue }, EVENT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      queue: FLOW_EVENTS_QUEUE,
      name: 'flow:event',
      data: { siteId: 's1', flowId: 'f1', event: EVENT },
    });
  });

  it('is a no-op without a queue provider', async () => {
    const { db } = makeDb([flow('f1', {})]);
    await expect(dispatchItemEvent({ db, siteId: 's1' }, EVENT)).resolves.toBeUndefined();
  });

  it('never throws when enqueue fails (mutate must not block on flows)', async () => {
    const { db } = makeDb([flow('f1', {})]);
    const { queue, enqueue } = makeQueue();
    enqueue.mockRejectedValue(new Error('queue down'));
    await expect(dispatchItemEvent({ db, siteId: 's1', queue }, EVENT)).resolves.toBeUndefined();
  });
});

describe('processFlowEventJob (Req 1.4)', () => {
  const job: FlowEventJob = { siteId: 's1', flowId: 'f1', event: EVENT };

  it('records a flow run and persists the outcome', async () => {
    const { db, inserted, updates } = makeDb([flow('f1', {})]);
    await processFlowEventJob(db, job);
    expect(inserted[0]).toMatchObject({
      siteId: 's1',
      flowId: 'f1',
      status: 'running',
      input: { event: EVENT },
      startedAt: expect.any(Date),
    });
    expect(updates[0]).toMatchObject({ status: 'success' });
    expect(updates[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it('skips flows deactivated between enqueue and consume', async () => {
    const { db, inserted } = makeDb([flow('f1', {}, 'inactive')]);
    await processFlowEventJob(db, job);
    expect(inserted).toHaveLength(0);
  });
});
