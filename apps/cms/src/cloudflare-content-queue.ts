import { createCloudflareRuntime, type QueueProvider } from '@lumibase/runtime';
import { z } from 'zod';
import { ackHealthProbes, openWorkerQueueResources } from './cloudflare-queue-common';
import type { Bindings } from './env';
import {
  CONTENT_INDEXING_QUEUE,
  registerContentIndexingWorker,
  type SearchIndexJob,
  type SearchRemoveJob,
} from './services/content-indexing-worker';
import {
  REVALIDATION_DISPATCH_QUEUE,
  registerRevalidationWorker,
  type RevalidationDispatchJob,
} from './services/content-invalidation';

/**
 * Cloudflare Workers consumers for the content side-effect queues (B131).
 *
 * `ItemService` enqueues `search:index` / `search:remove` on `content-indexing`
 * and `dispatchItemRevalidation` enqueues `dispatch` on `revalidation-dispatch`
 * after every write. Docker/Node consumes both in `serve.ts`. Before B131 the
 * Worker had neither a producer binding nor a consumer, so the enqueue threw,
 * the error was logged and swallowed, and on Workers the search index and the
 * ISR revalidation targets never saw a content change.
 *
 * Same pattern as `cloudflare-flow-queue.ts`: each batch registers the SAME
 * handler `serve.ts` registers and feeds each message through `handleMessage`,
 * so the processing code is shared by construction.
 *
 * Tenant: every job carries its `siteId`; the index name is
 * `{siteId}__{collection}` and the revalidation targets are read per site, as
 * on Docker. Workers-only: never import from serve.ts.
 */

const id = z.string().min(1);

const searchIndexData = z.object({
  siteId: id, collection: id, id,
  data: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<SearchIndexJob>;
const searchRemoveData = z.object({ siteId: id, collection: id, id }) satisfies z.ZodType<SearchRemoveJob>;
const contentIndexingMessage = z.discriminatedUnion('jobName', [
  z.object({ id, jobName: z.literal('search:index'), data: searchIndexData }),
  z.object({ id, jobName: z.literal('search:remove'), data: searchRemoveData }),
]);

const revalidationData = z.object({ siteId: id, collection: id }) satisfies z.ZodType<RevalidationDispatchJob>;
const revalidationMessage = z.object({ id, jobName: z.literal('dispatch'), data: revalidationData });

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
      // Never log bodies: an index job carries the item's field values.
      // Poison jobs exhaust bounded retries into the configured DLQ.
      console.error(`[${tag}] message failed`, { queue: batch.queue, messageId: message.id });
      message.retry({ delaySeconds: 30 });
    }
  }
}

/** `content-indexing`: `search:index` / `search:remove` for the tenant search index. */
export async function processCloudflareContentIndexingQueue(
  batch: MessageBatch<unknown>,
  env: Bindings,
): Promise<void> {
  const messages = ackHealthProbes(batch.messages);
  if (messages.length === 0) return;
  // Search is optional. Without a Meilisearch host there is no index to keep in
  // step, so ack instead of retrying every write into the DLQ.
  if (!env.MEILISEARCH_HOST) {
    for (const message of messages) message.ack();
    return;
  }
  // Indexing reads only the job payload and the search provider; no database.
  const runtime = createCloudflareRuntime({ ...env });
  const queue = runtime.queue;
  // Infra misconfiguration: throw before claiming anything so Cloudflare retries the batch.
  if (!canHandleMessages(queue)) throw new Error('Content indexing queue requires the Cloudflare queue provider.');
  registerContentIndexingWorker({
    search: runtime.search,
    queue,
  });
  await drain(batch, messages, queue, CONTENT_INDEXING_QUEUE, contentIndexingMessage, 'content-indexing-queue');
}

/** `revalidation-dispatch`: POST the site's ISR revalidation targets for a changed collection. */
export async function processCloudflareRevalidationQueue(
  batch: MessageBatch<unknown>,
  env: Bindings,
): Promise<void> {
  const messages = ackHealthProbes(batch.messages);
  if (messages.length === 0) return;
  const { db, runtime } = openWorkerQueueResources(env, 'Revalidation queue');
  const queue = runtime.queue;
  if (!canHandleMessages(queue)) throw new Error('Revalidation queue requires the Cloudflare queue provider.');
  registerRevalidationWorker({ db, queue });
  await drain(batch, messages, queue, REVALIDATION_DISPATCH_QUEUE, revalidationMessage, 'revalidation-queue');
}
