import { processCloudflareAgentQueue } from './cloudflare-agent-queue';
import { processCloudflareFlowEventsQueue, processCloudflareFlowRunsQueue } from './cloudflare-flow-queue';
import { ackHealthProbes } from './cloudflare-queue-common';
import type { Bindings } from './env';

/**
 * Worker `queue()` dispatcher (B10, B118).
 *
 * Cloudflare calls one `queue()` export for every consumer bound to the Worker;
 * `batch.queue` is the physical queue name (`lumibase-flow-runs-production`).
 * Each logical queue has its own parser, so routing is strict: a wrong fallback
 * would feed jobs to the wrong parser.
 *
 * `dockerRegistration` names the consumer `serve.ts` registers for the same
 * logical queue; `__tests__/worker-queue-consumers.wiring.test.ts` keeps the two
 * entrypoints in step.
 */
export const WORKER_QUEUE_CONSUMERS = {
  'agent-runs': { binding: 'AGENT_RUNS_QUEUE', dockerRegistration: 'registerAgentRunWorker' },
  'flow-runs': { binding: 'FLOW_RUNS_QUEUE', dockerRegistration: 'registerFlowRunsWorker' },
  'flow-events': { binding: 'FLOW_EVENTS_QUEUE', dockerRegistration: 'registerFlowEventWorker' },
} as const;

export type WorkerLogicalQueue = keyof typeof WORKER_QUEUE_CONSUMERS;

const HANDLERS: Record<WorkerLogicalQueue, (batch: MessageBatch<unknown>, env: Bindings) => Promise<void>> = {
  'agent-runs': processCloudflareAgentQueue,
  'flow-runs': processCloudflareFlowRunsQueue,
  'flow-events': processCloudflareFlowEventsQueue,
};

const QUEUE_NAME = /^(agent-runs|flow-runs|flow-events)(-[a-z0-9-]+)?$/;

/**
 * Physical queue name → logical queue. Accepts `lumibase-<logical>-<profile>`
 * and `<logical>[-<suffix>]`; an operator who renames queues must keep the
 * logical segment. Dead-letter queues (`…-dlq`) have no consumer here.
 */
export function resolveLogicalQueue(name: string): WorkerLogicalQueue | null {
  if (name.endsWith('-dlq')) return null;
  const match = QUEUE_NAME.exec(name.replace(/^lumibase-/, ''));
  return match ? (match[1] as WorkerLogicalQueue) : null;
}

/** The Worker's `queue()` export. */
export async function processCloudflareQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  const logical = resolveLogicalQueue(batch.queue);
  if (logical) {
    await HANDLERS[logical](batch, env);
    return;
  }
  // No consumer for this queue: retry so messages reach the DLQ instead of
  // vanishing. Never log bodies.
  for (const message of ackHealthProbes(batch.messages)) {
    console.error('[queue] no consumer for queue', { queue: batch.queue, messageId: message.id });
    message.retry({ delaySeconds: 30 });
  }
}
