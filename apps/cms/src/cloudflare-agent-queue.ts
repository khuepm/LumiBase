import { z } from 'zod';
import { ackHealthProbes, openWorkerQueueResources, principalRefSchema } from './cloudflare-queue-common';
import type { Bindings } from './env';
import { processAgentRunJob, type AgentRunJobPayload } from './services/agent-run-worker';

const id = z.string().min(1);
const payload = z.object({
  siteId: id, goalId: id, runId: id, skillName: id,
  arguments: z.record(z.string(), z.unknown()),
  principal: principalRefSchema.nullish(),
  capabilities: z.array(z.string()).optional(),
  userId: z.string().nullish(),
  contextMessage: z.string().optional(),
  origin: z.string().optional(),
  intentId: z.string().nullish(),
  driftFingerprint: z.string().nullish(),
  autonomyCap: z.number().int().min(0).max(4).nullish(),
  agentRole: z.string().nullish(),
  budget: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<AgentRunJobPayload>;
const messageSchema = z.object({ id, jobName: z.literal('execute'), data: payload });

/** Platform entrypoint: per-batch resources, per-message ack/retry, tenant in payload. */
export async function processCloudflareAgentQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  const messages = ackHealthProbes(batch.messages);
  if (messages.length === 0) return;
  // Throws before claiming a run. Cloudflare retries the batch on infra failure.
  const { db, runtime, workerEnv } = openWorkerQueueResources(env, 'Agent queue');
  for (const message of messages) {
    try {
      const job = messageSchema.parse(message.body);
      await processAgentRunJob({
        db, cache: runtime.cache, search: runtime.search, queue: runtime.queue,
        keys: runtime.keys, env: workerEnv,
      }, job.data);
      // CAS in processAgentRunJob also makes duplicate/cancelled deliveries no-ops.
      message.ack();
    } catch {
      // Do not log message bodies, arguments or provider credentials. Poison jobs
      // exhaust bounded retries into the configured DLQ instead of disappearing.
      console.error('[agent-queue] message failed', { queue: batch.queue, messageId: message.id });
      message.retry({ delaySeconds: 30 });
    }
  }
}
