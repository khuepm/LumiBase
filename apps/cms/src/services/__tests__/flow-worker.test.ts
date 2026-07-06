import type { Database } from '@lumibase/database';
import { describe, expect, it, vi } from 'vitest';
import { runFlowJob } from '../flow-worker';

/**
 * Fake db: select→flow row; insert→run row; update→capture final state.
 * The worker issues select().from().where().limit(), insert().values().returning(),
 * and update().set().where().
 */
function fakeDb(flow: Record<string, unknown> | null) {
  const captured: { finalState?: Record<string, unknown> } = {};
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(flow ? [flow] : []),
  };
  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve([{ id: 'run_1' }]),
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      captured.finalState = v;
      return updateChain;
    },
    where: () => Promise.resolve([]),
  };
  const db = {
    select: () => selectChain,
    insert: () => insertChain,
    update: () => updateChain,
  } as unknown as Database;
  return { db, captured };
}

const graph = { entry: 'a', nodes: [{ id: 'a', key: 'log', options: { message: 'hi' }, next: null }] };

describe('runFlowJob', () => {
  it('runs an active flow and finalizes the run with success + steps', async () => {
    const { db, captured } = fakeDb({ id: 'f1', siteId: 's1', status: 'active', graph });
    await runFlowJob({ db }, { siteId: 's1', flowId: 'f1', input: { x: 1 } });
    expect(captured.finalState?.status).toBe('success');
    expect(captured.finalState?.finishedAt).toBeInstanceOf(Date);
    // The `log` node recorded a step.
    expect(captured.finalState?.steps).toMatchObject({ a: { logged: true } });
  });

  it('does nothing when the flow is missing', async () => {
    const { db, captured } = fakeDb(null);
    await runFlowJob({ db }, { siteId: 's1', flowId: 'missing' });
    expect(captured.finalState).toBeUndefined();
  });

  it('skips a flow that was deactivated after enqueue', async () => {
    const { db, captured } = fakeDb({ id: 'f1', siteId: 's1', status: 'inactive', graph });
    await runFlowJob({ db }, { siteId: 's1', flowId: 'f1' });
    expect(captured.finalState).toBeUndefined();
  });
});
