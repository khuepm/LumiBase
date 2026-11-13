import type { Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';

/**
 * Workers counterparts of the periodic sweeps `serve.ts` runs on `node-cron`
 * (B131).
 *
 * Docker/Node schedules these with a leader lock. Cloudflare Workers runs them
 * from the Cron Trigger (`cloudflare.ts` `scheduled`), with no leader lock, so
 * two invocations can overlap: the minute and five-minute triggers both fire
 * on the five-minute mark, and a slow pass can outlive its minute. Every sweep
 * called here is safe under overlap, by its own guard rather than by a lock:
 *
 * - `runSchedulerTick` (publish/unpublish, releases, schedule flows):
 *   conditional updates; schedule flows advance `next_run_at` conditionally (B132).
 * - `runGoalDispatchTick`: per-goal dispatch lease, a conditional UPDATE (#455).
 * - `sweepAllSites` (deployment status): guarded updates, idempotent.
 * - `runCdcDispatchSweep`: best-effort lane lock, at-least-once delivery by design.
 * - `sweepDueVetoCommits`: `pending → deciding` claim per approval (B131).
 *
 * Cadence differs from Docker where Workers cannot match it: the shortest
 * Cron Trigger is one minute (Docker polls deployments and CDC every 30s), and
 * profiles without the minute trigger (staging) run these every five minutes.
 *
 * Each sweep is isolated: one failing never stops the others, and failures
 * are logged with `formatSafeError`, never swallowed. Workers-only: never
 * import from serve.ts.
 */

export interface WorkerSweepDeps {
  db: Database;
  runtime: RuntimeContext;
}

type Sweep = (deps: WorkerSweepDeps) => Promise<unknown>;

async function guarded(tag: string, sweep: () => Promise<unknown>): Promise<void> {
  try {
    await sweep();
  } catch (err) {
    console.error(`[${tag}] failed`, formatSafeError(err));
  }
}

/** Content scheduler tick: scheduled publish/unpublish, releases and schedule flows. */
const contentScheduler: Sweep = async ({ db, runtime }) => {
  const { runSchedulerTick } = await import('./services/scheduler-worker');
  return runSchedulerTick({ db, queue: runtime.queue });
};

/** Reconciler goal dispatch: turns reconciler goals into agent runs. */
const goalDispatch: Sweep = async ({ db, runtime }) => {
  const { runGoalDispatchTick } = await import('./services/goal-dispatch-service');
  const summary = await runGoalDispatchTick({ db, queue: runtime.queue });
  if (summary.dispatched > 0 || summary.blocked > 0 || summary.completed > 0) {
    console.log('[goal-dispatch] pass', JSON.stringify(summary));
  }
  return summary;
};

/** Deployment status poller: syncs queued/building deployments from their provider. */
const deploymentPoll: Sweep = async ({ db, runtime }) => {
  const { sweepAllSites } = await import('./services/deployment/status-poller');
  return sweepAllSites({ db, keys: runtime.keys, queue: runtime.queue });
};

/**
 * Change Feed push delivery backstop. Webhook subscriptions only: extension
 * subscribers load their bundle with a dynamic `import()` the Workers runtime
 * does not allow, and a lane whose sender always fails is eventually marked
 * dead. With no `extension` sender the dispatcher skips those lanes untouched;
 * they stay Docker-only (B131).
 */
const cdcDispatch: Sweep = async ({ db, runtime }) => {
  const { runCdcDispatchSweep, CdcDispatcher, createWebhookEnvelopeSender, DrizzleDeliveryLog, DrizzleSubscriptionDispatchStore } =
    await import('./modules/cdc/change-feed/dispatcher');
  const { DrizzleCdcEventStore } = await import('./modules/cdc/change-feed/feed-reader');
  const { DrizzleRetentionStore, pruneChangeFeed, readRetentionDays } = await import('./modules/cdc/change-feed/retention');
  const subscriptions = new DrizzleSubscriptionDispatchStore(db);
  return runCdcDispatchSweep({
    subscriptions,
    prune: async (siteId) => {
      await pruneChangeFeed(
        { store: new DrizzleRetentionStore(db), retentionDays: await readRetentionDays(db, siteId) },
        siteId,
      );
    },
    buildDispatcher: () =>
      new CdcDispatcher({
        eventStore: new DrizzleCdcEventStore(db),
        subscriptions,
        deliveryLog: new DrizzleDeliveryLog(db),
        senders: { webhook: createWebhookEnvelopeSender(db) },
        cache: runtime.cache,
      }),
  });
};

/** Veto-window commits: commits every due staging the queue path did not. */
const vetoCommits: Sweep = async ({ db, runtime }) => {
  const { sweepDueVetoCommits } = await import('./services/veto-commit-worker');
  return sweepDueVetoCommits({ db, cache: runtime.cache, search: runtime.search, queue: runtime.queue });
};

/** Retention policies (Req 12.2). Docker runs it hourly at :17. */
const retention: Sweep = async ({ db, runtime }) => {
  const { sweepRetention } = await import('./services/scheduler-worker');
  return sweepRetention({ db, queue: runtime.queue });
};

/** Sweeps Docker runs every minute or faster. */
export const MINUTE_SWEEPS: Record<string, Sweep> = {
  'content-scheduler': contentScheduler,
  'goal-dispatch': goalDispatch,
  'deployment-poll': deploymentPoll,
  'cdc-dispatch': cdcDispatch,
};

/** Sweeps Docker runs every five minutes. */
export const FIVE_MINUTE_SWEEPS: Record<string, Sweep> = {
  'veto-sweep': vetoCommits,
};

/** Sweeps Docker runs hourly. */
export const HOURLY_SWEEPS: Record<string, Sweep> = {
  'retention-sweep': retention,
};

/** Runs every sweep in `sweeps` concurrently; resolves when all have settled. Never throws. */
export async function runWorkerSweeps(sweeps: Record<string, Sweep>, deps: WorkerSweepDeps): Promise<void> {
  await Promise.all(Object.entries(sweeps).map(([tag, sweep]) => guarded(tag, () => sweep(deps))));
}
