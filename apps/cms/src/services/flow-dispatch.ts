/**
 * Flow event dispatch — matches item mutations to active event-triggered flows
 * and enqueues them for asynchronous execution.
 *
 * An event flow declares `triggerType: 'event'` and, in `triggerOptions`, the
 * `collection` and `actions` it listens for. `findActiveEventFlows` selects the
 * flows a given (collection, action) mutation should fire; `dispatchItemEvent`
 * enqueues one job per matched flow via `runtime.queue` so the mutation's own
 * response is never blocked on flow execution.
 *
 * See `.kiro/specs/visual-flow-builder` (task 3).
 */

import { flows } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { QueueProvider } from '@lumibase/runtime';

export type ItemAction = 'create' | 'update' | 'delete';

/** The queue name event-flow jobs are enqueued on. */
export const FLOW_EVENT_QUEUE = 'flow-events';

export interface FlowEventJob {
  siteId: string;
  flowId: string;
  collection: string;
  action: ItemAction;
  itemId: string;
  payload: unknown;
}

interface EventTriggerOptions {
  collection?: string;
  /** Actions the flow listens for; empty/absent → all actions. */
  actions?: ItemAction[];
}

/**
 * Active event flows for the site whose trigger matches this (collection,
 * action). Filtering is done in memory over the site's event flows so the
 * `triggerOptions` JSON shape stays flexible. Every query is site-scoped.
 */
export async function findActiveEventFlows(
  db: Database,
  siteId: string,
  collection: string,
  action: ItemAction,
): Promise<{ id: string }[]> {
  const rows = await db
    .select({ id: flows.id, triggerOptions: flows.triggerOptions })
    .from(flows)
    .where(and(eq(flows.siteId, siteId), eq(flows.status, 'active'), eq(flows.triggerType, 'event')));

  return rows
    .filter((r) => {
      const opts = (r.triggerOptions ?? {}) as EventTriggerOptions;
      if (opts.collection && opts.collection !== collection) return false;
      if (Array.isArray(opts.actions) && opts.actions.length > 0 && !opts.actions.includes(action)) {
        return false;
      }
      return true;
    })
    .map((r) => ({ id: r.id }));
}

export interface DispatchDeps {
  db: Database;
  queue?: QueueProvider;
}

/**
 * Enqueue every matching event flow for a mutation. Fire-and-forget: returns
 * the number of flows dispatched; enqueue failures are swallowed (logged) so a
 * flaky queue never breaks the mutation path.
 */
export async function dispatchItemEvent(
  deps: DispatchDeps,
  ev: { siteId: string; collection: string; action: ItemAction; itemId: string; payload: unknown },
): Promise<number> {
  if (!deps.queue) return 0;
  const matched = await findActiveEventFlows(deps.db, ev.siteId, ev.collection, ev.action);
  let dispatched = 0;
  for (const flow of matched) {
    const job: FlowEventJob = { flowId: flow.id, ...ev };
    try {
      await deps.queue.enqueue(FLOW_EVENT_QUEUE, 'run-event-flow', job);
      dispatched += 1;
    } catch (err) {
      console.error('[flow-dispatch] enqueue failed', {
        flowId: flow.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dispatched;
}
