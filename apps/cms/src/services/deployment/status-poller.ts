import { inArray } from 'drizzle-orm';
import { deployments, type Database } from '@lumibase/database';
import type { KeyProvider, QueueProvider } from '@lumibase/runtime';
import { DeploymentService } from './deployment-service';

/**
 * Deployment status poller (spec: deployment-integrations, design §6.3).
 *
 * Mirrors the content scheduler model (scheduler-worker.ts): a periodic tick
 * on the runtime QueueProvider syncs every non-terminal deployment from its
 * Provider. Partial failure is contained (one deployment's sync error does not
 * abort the sweep) and updates are idempotent (DeploymentService.syncDeployment
 * only flips rows still in `queued`/`building`), so re-running over the same
 * set is a no-op.
 */

export const DEPLOYMENT_POLL_QUEUE = 'deployment-status';

export interface PollerDeps {
  db: Database;
  keys: KeyProvider;
  queue?: QueueProvider;
}

export interface SweepResult {
  checked: number;
  errors: number;
}

/** Sync all non-terminal deployments for one site. Never throws on a single failure. */
export async function sweepPending(deps: PollerDeps, siteId: string): Promise<SweepResult> {
  const service = new DeploymentService({ db: deps.db, siteId, keys: deps.keys });
  const ids = await service.pendingDeploymentIds();
  let errors = 0;
  for (const id of ids) {
    try {
      await service.syncDeployment(id);
    } catch {
      // Best-effort: a provider error on one deployment must not abort the
      // sweep; it is retried on the next tick (idempotent).
      errors += 1;
    }
  }
  return { checked: ids.length, errors };
}

/**
 * Cross-site sweep for the cron safety-net (serve.ts). Finds every site with a
 * non-terminal deployment and sweeps each, isolating per-site failures.
 */
export async function sweepAllSites(deps: PollerDeps): Promise<SweepResult> {
  const rows = await deps.db
    .selectDistinct({ siteId: deployments.siteId })
    .from(deployments)
    .where(inArray(deployments.status, ['queued', 'building']));
  let checked = 0;
  let errors = 0;
  for (const { siteId } of rows) {
    try {
      const r = await sweepPending(deps, siteId);
      checked += r.checked;
      errors += r.errors;
    } catch {
      errors += 1;
    }
  }
  return { checked, errors };
}

/**
 * Register the queue consumer. The job payload carries the `siteId` to sweep,
 * keeping the worker tenant-scoped exactly like the content scheduler.
 */
export function registerStatusPoller(deps: PollerDeps): void {
  if (!deps.queue) return;
  deps.queue.process<{ siteId: string }>(DEPLOYMENT_POLL_QUEUE, async (job) => {
    await sweepPending(deps, job.data.siteId);
  });
}
