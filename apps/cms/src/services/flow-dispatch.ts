import { flows, flowRuns, type Database } from '@lumibase/database';
import type { KeyProvider, QueueProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, eq } from 'drizzle-orm';
import { runFlow, type FlowGraph } from './flow-service';

/**
 * Flow event trigger (visual-flow-builder Req 1).
 *
 * ItemService calls `dispatchItemEvent` after a committed create/update/delete.
 * Matching active `event` flows are enqueued one job per flow on the
 * `flow-events` queue; the consumer (`registerFlowEventWorker`, or the CF queue
 * export) loads the flow and executes it, recording a `flow_runs` row. The
 * mutate response never waits for flow execution — only for the enqueue, which
 * is non-critical and swallowed on failure.
 */

export const FLOW_EVENTS_QUEUE = 'flow-events';

export type ItemEventAction = 'create' | 'update' | 'delete';

export interface ItemEvent {
  collection: string;
  action: ItemEventAction;
  itemId: string;
  payload: Record<string, unknown>;
}

export interface FlowEventJob {
  siteId: string;
  flowId: string;
  /** Item mutation that fired the flow (event trigger). */
  event?: ItemEvent;
  /** Pre-built run input (schedule trigger); wins over `event` when set. */
  input?: Record<string, unknown>;
}

/** Trigger config for `triggerType='event'` flows, stored in `flows.trigger_options`. */
interface EventTriggerOptions {
  /** Collection name(s) to match; missing/empty = every collection. */
  collection?: string | string[];
  /** Action(s) to match; missing/empty = every action. */
  action?: string | string[];
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function triggerMatches(options: EventTriggerOptions, collection: string, action: ItemEventAction): boolean {
  const collections = asList(options.collection);
  const actions = asList(options.action);
  return (
    (collections.length === 0 || collections.includes(collection)) &&
    (actions.length === 0 || actions.includes(action))
  );
}

/** Active event-triggered flows of this site whose trigger matches the mutation. */
export async function findActiveEventFlows(
  db: Database,
  siteId: string,
  collection: string,
  action: ItemEventAction,
) {
  const rows = await db
    .select()
    .from(flows)
    .where(and(eq(flows.siteId, siteId), eq(flows.status, 'active'), eq(flows.triggerType, 'event')));
  return rows.filter((f) =>
    triggerMatches((f.triggerOptions ?? {}) as EventTriggerOptions, collection, action),
  );
}

export interface FlowDispatchDeps {
  db: Database;
  siteId: string;
  queue?: QueueProvider;
}

/**
 * Enqueue one `flow:event` job per matching flow. Never throws — flow fan-out
 * is non-critical to the mutation that triggered it.
 */
export async function dispatchItemEvent(deps: FlowDispatchDeps, event: ItemEvent): Promise<void> {
  if (!deps.queue) return;
  try {
    const matched = await findActiveEventFlows(deps.db, deps.siteId, event.collection, event.action);
    if (matched.length === 0) return;
    await Promise.allSettled(
      matched.map((flow) =>
        deps.queue!.enqueue<FlowEventJob>(FLOW_EVENTS_QUEUE, 'flow:event', {
          siteId: deps.siteId,
          flowId: flow.id,
          event,
        }),
      ),
    );
  } catch (err) {
    console.error('[flow-dispatch] event dispatch failed', {
      collection: event.collection,
      action: event.action,
      err: formatSafeError(err),
    });
  }
}

/**
 * Execute one enqueued flow job: re-check the flow is still active (it may
 * have been deactivated between enqueue and consume), record the run, execute,
 * persist the outcome. Shared by the Docker worker and the CF queue consumer.
 */
export async function processFlowEventJob(
  db: Database,
  job: FlowEventJob,
  keys?: KeyProvider,
): Promise<void> {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, job.flowId), eq(flows.siteId, job.siteId)));
  if (!flow || flow.status !== 'active') return;

  const input = job.input ?? ({ event: job.event } as Record<string, unknown>);
  const [run] = await db
    .insert(flowRuns)
    .values({ siteId: job.siteId, flowId: job.flowId, status: 'running', input, startedAt: new Date() })
    .returning();

  const result = await runFlow(flow.graph as FlowGraph, input, {
    db,
    siteId: job.siteId,
    keys,
    runId: run!.id,
  });

  await db
    .update(flowRuns)
    .set({ status: result.status, steps: result.steps, error: result.error ?? null, finishedAt: new Date() })
    .where(eq(flowRuns.id, run!.id));
}

export interface FlowEventWorkerDeps {
  db: Database;
  queue?: QueueProvider;
  keys?: KeyProvider;
}

/** Registers the flow-events consumer on a long-lived runtime (Docker/Node). */
export function registerFlowEventWorker(deps: FlowEventWorkerDeps): void {
  const { db, queue, keys } = deps;
  if (!queue) return;

  queue.process<FlowEventJob>(FLOW_EVENTS_QUEUE, async (job) => {
    try {
      if (job.name === 'flow:event' || job.name === 'flow:scheduled') {
        await processFlowEventJob(db, job.data, keys);
      }
    } catch (err) {
      // A failed flow run must not crash the worker; the queue applies its
      // own retry policy.
      console.error('[flow-events] job failed', { job: job.name, err: formatSafeError(err) });
      throw err;
    }
  });
}
