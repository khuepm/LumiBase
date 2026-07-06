/**
 * Flow queue worker — consumes the jobs enqueued by event dispatch
 * (`flow-events`) and the schedule runner (`flow-schedule`). For each job it
 * loads the flow (site-scoped), records a `flowRuns` row, runs the graph via
 * `runFlow`, and finalizes the run with status + per-node steps.
 *
 * Registered on long-lived runtimes (Docker/Node) via `registerFlowWorker`;
 * on Cloudflare the same `runFlowJob` handler is invoked from the Queue
 * consumer. See `.kiro/specs/visual-flow-builder` (tasks 3.3, 4.x).
 */

import { flowRuns, flows } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { KeyProvider, QueueProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/shared/utils';
import { runFlow, type FlowGraph } from './flow-service';
import { FLOW_EVENT_QUEUE, type FlowEventJob } from './flow-dispatch';
import { FLOW_SCHEDULE_QUEUE, type FlowScheduleJob } from './flow-scheduler';

export interface FlowWorkerDeps {
  db: Database;
  queue?: QueueProvider;
  keys?: KeyProvider;
}

/**
 * Execute one queued flow job. `input` is the event payload (event flows) or an
 * empty schedule marker (schedule flows). Idempotency is best-effort: each job
 * inserts its own `flowRuns` row, so a redelivered job produces a new run
 * rather than corrupting an existing one.
 */
export async function runFlowJob(
  deps: FlowWorkerDeps,
  job: { siteId: string; flowId: string; input?: Record<string, unknown> },
): Promise<void> {
  const { db, keys } = deps;
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, job.flowId), eq(flows.siteId, job.siteId)))
    .limit(1);
  if (!flow) {
    console.warn('[flow-worker] flow not found for job', { flowId: job.flowId, siteId: job.siteId });
    return;
  }
  // A flow deactivated between enqueue and consume should not run.
  if (flow.status !== 'active') return;

  const input = job.input ?? {};
  const [run] = await db
    .insert(flowRuns)
    .values({ siteId: job.siteId, flowId: job.flowId, status: 'running', input })
    .returning();

  const result = await runFlow(flow.graph as FlowGraph, input, {
    db,
    siteId: job.siteId,
    keys,
    runId: run!.id,
  });

  await db
    .update(flowRuns)
    .set({
      status: result.status,
      steps: result.steps,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(flowRuns.id, run!.id));
}

/**
 * Register the flow consumers on a long-lived runtime. No-op without a queue.
 * A job failure is logged and rethrown so the queue applies its retry policy.
 */
export function registerFlowWorker(deps: FlowWorkerDeps): void {
  const { queue } = deps;
  if (!queue) return;

  queue.process<FlowEventJob>(FLOW_EVENT_QUEUE, async (job) => {
    try {
      const data = job.data;
      await runFlowJob(deps, {
        siteId: data.siteId,
        flowId: data.flowId,
        input: { collection: data.collection, action: data.action, itemId: data.itemId, payload: data.payload },
      });
    } catch (err) {
      console.error('[flow-worker] event job failed', { err: formatSafeError(err) });
      throw err;
    }
  });

  queue.process<FlowScheduleJob>(FLOW_SCHEDULE_QUEUE, async (job) => {
    try {
      await runFlowJob(deps, { siteId: job.data.siteId, flowId: job.data.flowId, input: { scheduled: true } });
    } catch (err) {
      console.error('[flow-worker] schedule job failed', { err: formatSafeError(err) });
      throw err;
    }
  });
}
