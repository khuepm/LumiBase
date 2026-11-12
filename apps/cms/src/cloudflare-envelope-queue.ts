import type { QueueProvider } from '@lumibase/runtime';
import { z } from 'zod';
import { ackHealthProbes, openWorkerQueueResources } from './cloudflare-queue-common';
import type { Bindings } from './env';
import { ENVELOPE_MIGRATION_QUEUE, runEnvelopeMigration } from './services/envelope-migration-worker';

/**
 * Cloudflare Workers consumer for `encryption-envelope-migration` (B131).
 *
 * `PATCH /admin/encryption/envelope` migrates a bounded set of batches inline
 * and hands the long tail to this queue. Docker's `registerEnvelopeMigrationWorker`
 * drains it in one unbounded call. A Worker invocation has a CPU budget, so
 * each message here runs at most {@link WORKER_MAX_BATCHES} batches and, if the
 * scan is not done, enqueues a continuation. The cursor lives in the site's
 * envelope setting, so every pass resumes where the last one stopped, exactly
 * as a second Docker run would.
 *
 * Tenant: the job carries its `siteId`; the migration reads and writes that
 * site only. Workers-only: never import from serve.ts.
 */

export const WORKER_MAX_BATCHES = 50;

const message = z.object({
  id: z.string().min(1),
  jobName: z.literal('migrate'),
  data: z.object({ siteId: z.string().min(1) }),
});

export async function processCloudflareEnvelopeMigrationQueue(
  batch: MessageBatch<unknown>,
  env: Bindings,
): Promise<void> {
  const messages = ackHealthProbes(batch.messages);
  if (messages.length === 0) return;
  const { db, runtime } = openWorkerQueueResources(env, 'Envelope migration queue');
  const queue: QueueProvider = runtime.queue;
  for (const m of messages) {
    try {
      const { data } = message.parse(m.body);
      const result = await runEnvelopeMigration(
        { db, siteId: data.siteId, keyProvider: runtime.keys },
        { maxBatches: WORKER_MAX_BATCHES },
      );
      if (!result.done) {
        await queue.enqueue(ENVELOPE_MIGRATION_QUEUE, 'migrate', { siteId: data.siteId });
      }
      m.ack();
    } catch {
      // Never log bodies or key material. The cursor is persisted per batch,
      // so a retry resumes rather than restarting.
      console.error('[envelope-migration-queue] message failed', { queue: batch.queue, messageId: m.id });
      m.retry({ delaySeconds: 30 });
    }
  }
}
