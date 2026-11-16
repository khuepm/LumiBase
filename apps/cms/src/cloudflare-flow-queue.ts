import type { QueueProvider } from '@lumibase/runtime';
import { z } from 'zod';
import { ackHealthProbes, openWorkerQueueResources, principalRefSchema } from './cloudflare-queue-common';
import type { Bindings } from './env';
import { FLOW_EVENTS_QUEUE, registerFlowEventWorker, type FlowEventJob } from './services/flow-dispatch';
import { FLOW_RUNS_QUEUE, registerFlowRunsWorker, type FlowRunJob } from './services/flow-run-service';

/**
 * Cloudflare Workers consumers for the Flows queues (B118).
 *
 * Docker/Node registers `registerFlowRunsWorker` / `registerFlowEventWorker` on
 * a long-lived BullMQ provider (`serve.ts`). Workers has no long-lived process,
 * so each batch builds the same providers outside a request, registers the SAME
 * handlers on the Cloudflare queue provider and feeds each message through
 * `handleMessage`. Same job-name filter, same processing function, same deps
 * shape as Docker — parity by construction, checked by
 * `__tests__/worker-queue-consumers.wiring.test.ts`.
 *
 * Tenant: every job carries its `siteId`; the shared services scope every
 * query by it, exactly as on Docker. Workers-only: never import from serve.ts.
 */

const id = z.string().min(1);
const record = z.record(z.string(), z.unknown());

const flowRunData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flow'),
    siteId: id, runId: id, flowId: id,
    input: record,
    principal: principalRefSchema.nullish(),
  }),
  z.object({
    kind: z.literal('ai_chat'),
    siteId: id, runId: id, conversationId: id,
    message: z.string(),
    userCapabilities: z.array(z.string()).optional(),
    principal: principalRefSchema.nullish(),
    userId: z.string().nullable(),
  }),
]) satisfies z.ZodType<FlowRunJob>;
const flowRunsMessage = z.object({ id, jobName: z.enum(['flow:run', 'ai:chat']), data: flowRunData });

const flowEventData = z.object({
  siteId: id, flowId: id,
  event: z.object({
    collection: z.string(),
    action: z.enum(['create', 'update', 'delete']),
    itemId: z.string(),
    payload: record,
  }).optional(),
  input: record.optional(),
}) satisfies z.ZodType<FlowEventJob>;
const flowEventsMessage = z.object({ id, jobName: z.enum(['flow:event', 'flow:scheduled']), data: flowEventData });

type MessageHandlingQueue = QueueProvider & {
  handleMessage(queueName: string, body: { id: string; jobName: string; data: unknown }): Promise<void>;
};

function canHandleMessages(queue: QueueProvider): queue is MessageHandlingQueue {
  return typeof (queue as { handleMessage?: unknown }).handleMessage === 'function';
}

async function drain(
  batch: MessageBatch<unknown>,
  messages: readonly Message<unknown>[],
  queue: MessageHandlingQueue,
  logical: string,
  schema: z.ZodType<{ id: string; jobName: string; data: unknown }>,
  tag: string,
): Promise<void> {
  for (const message of messages) {
    try {
      const job = schema.parse(message.body);
      await queue.handleMessage(logical, job);
      message.ack();
    } catch {
      // Never log bodies (flow input, chat message) or provider credentials.
      // Poison jobs exhaust bounded retries into the configured DLQ.
      console.error(`[${tag}] message failed`, { queue: batch.queue, messageId: message.id });
      message.retry({ delaySeconds: 30 });
    }
  }
}

/** `flow-runs`: manual flow runs (`flow:run`, J10 `ai:decision`) and async AI chat (`ai:chat`). */
export async function processCloudflareFlowRunsQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  const messages = ackHealthProbes(batch.messages);
  if (messages.length === 0) return;
  const { db, runtime, workerEnv } = openWorkerQueueResources(env, 'Flow runs queue');
  const queue = runtime.queue;
  // Infra misconfiguration: throw before claiming anything so Cloudflare retries the batch.
  if (!canHandleMessages(queue)) throw new Error('Flow runs queue requires the Cloudflare queue provider.');
  registerFlowRunsWorker({
    cache: runtime.cache,
    db,
    queue,
    keys: runtime.keys,
    env: workerEnv,
  });
  await drain(batch, messages, queue, FLOW_RUNS_QUEUE, flowRunsMessage, 'flow-runs-queue');
}

/** `flow-events`: event-triggered (`flow:event`) and scheduled (`flow:scheduled`) flow runs. */
export async function processCloudflareFlowEventsQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  const messages = ackHealthProbes(batch.messages);
  if (messages.length === 0) return;
  const { db, runtime, workerEnv } = openWorkerQueueResources(env, 'Flow events queue');
  const queue = runtime.queue;
  if (!canHandleMessages(queue)) throw new Error('Flow events queue requires the Cloudflare queue provider.');
  registerFlowEventWorker({
    cache: runtime.cache,
    db,
    queue,
    keys: runtime.keys,
    env: workerEnv,
  });
  await drain(batch, messages, queue, FLOW_EVENTS_QUEUE, flowEventsMessage, 'flow-events-queue');
}
