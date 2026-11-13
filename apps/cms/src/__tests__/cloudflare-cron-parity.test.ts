import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { FIVE_MINUTE_SWEEPS, HOURLY_SWEEPS, MINUTE_SWEEPS, runWorkerSweeps } from '../cloudflare-cron-parity';
import { runSchedulerTick, sweepRetention } from '../services/scheduler-worker';
import { runGoalDispatchTick } from '../services/goal-dispatch-service';
import { sweepAllSites } from '../services/deployment/status-poller';
import { sweepDueVetoCommits } from '../services/veto-commit-worker';
import { runCdcDispatchSweep } from '../modules/cdc/change-feed/dispatcher';

/**
 * Workers counterparts of the Docker node-cron sweeps (B131). Each sweep gets
 * the providers Docker passes, and one failing sweep never stops the others or
 * disappears without a formatted log line.
 */

vi.mock('../services/scheduler-worker', () => ({
  runSchedulerTick: vi.fn(async () => ({ published: 0, unpublished: 0, releasesPublished: 0, flowsEnqueued: 0 })),
  sweepRetention: vi.fn(async () => 0),
}));
vi.mock('../services/goal-dispatch-service', () => ({
  runGoalDispatchTick: vi.fn(async () => ({ sites: 0, dispatched: 0, completed: 0, skipped: 0, blocked: 0 })),
}));
vi.mock('../services/deployment/status-poller', () => ({ sweepAllSites: vi.fn(async () => ({ checked: 0, errors: 0 })) }));
vi.mock('../services/veto-commit-worker', () => ({ sweepDueVetoCommits: vi.fn(async () => 0) }));
vi.mock('../modules/cdc/change-feed/dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/cdc/change-feed/dispatcher')>();
  return { ...actual, runCdcDispatchSweep: vi.fn(async () => {}) };
});

const db = { marker: 'db' } as unknown as Database;
const runtime = {
  cache: { marker: 'cache' },
  search: { marker: 'search' },
  keys: { marker: 'keys' },
  queue: { marker: 'queue' },
} as unknown as RuntimeContext;
const deps = { db, runtime };

beforeEach(() => vi.clearAllMocks());

describe('sweep schedule (B131)', () => {
  it('splits the sweeps by the cadence Docker runs them at', () => {
    expect(Object.keys(MINUTE_SWEEPS).sort()).toEqual(['cdc-dispatch', 'content-scheduler', 'deployment-poll', 'goal-dispatch']);
    expect(Object.keys(FIVE_MINUTE_SWEEPS)).toEqual(['veto-sweep']);
    expect(Object.keys(HOURLY_SWEEPS)).toEqual(['retention-sweep']);
  });
});

describe('runWorkerSweeps passes the Docker providers (B131)', () => {
  it('minute sweeps', async () => {
    await runWorkerSweeps(MINUTE_SWEEPS, deps);
    expect(runSchedulerTick).toHaveBeenCalledWith({ db, queue: runtime.queue });
    expect(runGoalDispatchTick).toHaveBeenCalledWith({ db, queue: runtime.queue });
    expect(sweepAllSites).toHaveBeenCalledWith({ db, keys: runtime.keys, queue: runtime.queue });
    expect(runCdcDispatchSweep).toHaveBeenCalledOnce();
  });

  it('veto and retention sweeps', async () => {
    await runWorkerSweeps({ ...FIVE_MINUTE_SWEEPS, ...HOURLY_SWEEPS }, deps);
    expect(sweepDueVetoCommits).toHaveBeenCalledWith({ db, cache: runtime.cache, search: runtime.search, queue: runtime.queue });
    expect(sweepRetention).toHaveBeenCalledWith({ db, queue: runtime.queue });
  });

  it('the CDC sweep delivers to webhooks only, so extension lanes are skipped, not failed', async () => {
    await runWorkerSweeps({ 'cdc-dispatch': MINUTE_SWEEPS['cdc-dispatch']! }, deps);
    const sweepDeps = vi.mocked(runCdcDispatchSweep).mock.calls[0]![0];
    const dispatcher = sweepDeps.buildDispatcher() as unknown as { deps: { senders: Record<string, unknown>; cache: unknown } };
    expect(Object.keys(dispatcher.deps.senders)).toEqual(['webhook']);
    expect(dispatcher.deps.cache).toBe(runtime.cache);
  });
});

describe('isolation (B131)', () => {
  it('a failing sweep is logged with its tag and does not stop the others', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runSchedulerTick).mockRejectedValueOnce(new Error('db down'));
    await expect(runWorkerSweeps(MINUTE_SWEEPS, deps)).resolves.toBeUndefined();
    expect(runGoalDispatchTick).toHaveBeenCalledOnce();
    expect(sweepAllSites).toHaveBeenCalledOnce();
    expect(runCdcDispatchSweep).toHaveBeenCalledOnce();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('[content-scheduler] failed');
    expect(logged).toContain('db down');
    log.mockRestore();
  });
});
