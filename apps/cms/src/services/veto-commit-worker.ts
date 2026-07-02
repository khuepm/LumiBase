import { agentApprovals, type Database } from '@lumibase/database';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { CacheProvider, QueueProvider, SearchProvider } from '@lumibase/runtime';
import { itemServiceForSystem } from './item-service-factory';
import { VETO_COMMIT_MAX_ATTEMPTS, VetoService } from './veto-service';

/**
 * Veto-window commit runner (Content OS task 14.2 / Req 13.3, 13.5).
 *
 * Primary path: staging enqueues a delayed job on `agent-veto-commits`
 * that fires at `autoCommitAt`. Safety net: a periodic sweep commits any
 * due staging the queue missed (lost jobs, runtimes without a queue
 * adapter). Both paths converge on `VetoService.commit`, which re-checks
 * the approval status and deadline before touching anything — a veto or
 * an early job can never cause a premature or double commit.
 */

export const VETO_COMMITS_QUEUE = 'agent-veto-commits';

export interface VetoCommitJobPayload {
  siteId: string;
  approvalId: string;
  /** 1-based delivery attempt; drives backoff and the failure incident. */
  attempt?: number;
}

export interface VetoCommitWorkerDeps {
  db: Database;
  cache?: CacheProvider;
  search?: SearchProvider;
  queue?: QueueProvider;
}

function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), 30 * 60_000);
}

export async function processVetoCommitJob(
  deps: VetoCommitWorkerDeps,
  payload: VetoCommitJobPayload,
): Promise<void> {
  const attempt = payload.attempt ?? 1;
  const veto = new VetoService({ db: deps.db, siteId: payload.siteId });
  // System context: the veto window already captured the human authorization
  // decision; committing an approved change runs with system privileges.
  const itemService = itemServiceForSystem(
    {
      db: deps.db,
      siteId: payload.siteId,
      cache: deps.cache,
      search: deps.search,
      queue: deps.queue,
    },
    'background-worker',
  );

  try {
    const result = await veto.commit(payload.approvalId, itemService);
    if (result.outcome === 'waiting' && deps.queue) {
      // Fired early (clock skew / re-delivery): try again at the deadline.
      await deps.queue.enqueue<VetoCommitJobPayload>(
        VETO_COMMITS_QUEUE,
        'commit',
        { ...payload, attempt },
        { delay: 60_000 },
      );
    }
  } catch (err) {
    // Staging stays intact on failure (Req 13.5); retry with backoff and
    // open an incident once the attempts are exhausted.
    const message = err instanceof Error ? err.message : String(err);
    await veto.recordCommitFailure(payload.approvalId, attempt, message);
    if (attempt < VETO_COMMIT_MAX_ATTEMPTS && deps.queue) {
      await deps.queue.enqueue<VetoCommitJobPayload>(
        VETO_COMMITS_QUEUE,
        'commit',
        { ...payload, attempt: attempt + 1 },
        { delay: backoffMs(attempt) },
      );
    }
  }
}

/** Long-lived runtime consumer (Docker/Node). */
export function registerVetoCommitWorker(deps: VetoCommitWorkerDeps): void {
  deps.queue?.process<VetoCommitJobPayload>(VETO_COMMITS_QUEUE, async (job) => {
    await processVetoCommitJob(deps, job.data);
  });
}

/**
 * Safety-net sweep: commits every due staging across sites. System-level
 * job (like audit rotation) — it iterates due approvals and processes each
 * within its own site scope.
 */
export async function sweepDueVetoCommits(deps: VetoCommitWorkerDeps, now = new Date()): Promise<number> {
  const due = await deps.db
    .select({ id: agentApprovals.id, siteId: agentApprovals.siteId })
    .from(agentApprovals)
    .where(
      and(
        eq(agentApprovals.kind, 'veto'),
        eq(agentApprovals.status, 'pending'),
        lte(agentApprovals.autoCommitAt, now),
      ),
    )
    .orderBy(asc(agentApprovals.autoCommitAt))
    .limit(100);

  for (const approval of due) {
    await processVetoCommitJob(deps, { siteId: approval.siteId, approvalId: approval.id });
  }
  return due.length;
}
