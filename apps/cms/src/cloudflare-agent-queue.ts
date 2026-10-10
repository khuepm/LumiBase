import { createDb } from '@lumibase/database';
import { createCloudflareRuntime } from '@lumibase/runtime';
import { z } from 'zod';
import type { Bindings } from './env';
import { processAgentRunJob, type AgentRunJobPayload } from './services/agent-run-worker';

const id = z.string().min(1);
const principal = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), siteId: id, userId: id }),
  z.object({ type: z.literal('api_key'), siteId: id, apiKeyId: id }),
  z.object({ type: z.literal('dev'), siteId: id, roles: z.array(z.string()) }),
]);
const payload = z.object({
  siteId: id, goalId: id, runId: id, skillName: id,
  arguments: z.record(z.string(), z.unknown()),
  principal: principal.nullish(),
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
const healthSchema = z.object({ id, jobName: z.literal('health_check'), data: z.object({ ts: z.number() }) });

/** Platform entrypoint: per-batch resources, per-message ack/retry, tenant in payload. */
export async function processCloudflareAgentQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  // The generic health probe targets the first configured queue, which can be
  // this one. Its harmless messages need no database or agent execution.
  const messages = batch.messages.filter((message) => {
    if (!healthSchema.safeParse(message.body).success) return true;
    message.ack();
    return false;
  });
  if (messages.length === 0) return;
  const connectionString = env.HYPERDRIVE?.connectionString
    ?? (env.LUMIBASE_ENV === 'development' ? env.DATABASE_URL : undefined);
  if (!connectionString) {
    // Throw before claiming a run. Cloudflare retries the batch on infra failure.
    throw new Error('Agent queue requires HYPERDRIVE (or development DATABASE_URL).');
  }
  const db = createDb(connectionString);
  const runtime = createCloudflareRuntime({ ...env });
  // LLM configuration contains strings only; never cast Worker bindings to env strings.
  const workerEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') workerEnv[key] = value;
  }
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
