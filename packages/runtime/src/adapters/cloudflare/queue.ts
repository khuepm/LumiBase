import type { QueueProvider, Job, JobOptions } from '../../interfaces';

/**
 * Cloudflare Queue binding type.
 * Declared locally to avoid dependency on @cloudflare/workers-types in the shared package.
 */
export interface CloudflareQueue {
  send(message: unknown, options?: { contentType?: string; delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: unknown; contentType?: string; delaySeconds?: number }>): Promise<void>;
}

/**
 * Message envelope sent to Cloudflare Queues.
 * Wraps job metadata alongside the payload so consumers can reconstruct Job objects.
 */
interface QueueMessage<T = unknown> {
  id: string;
  jobName: string;
  data: T;
  options?: JobOptions;
}

/**
 * Cloudflare Queues-backed QueueProvider.
 *
 * Limitations:
 * - `getStatus` always returns null because Cloudflare Queues does not provide
 *   per-message status tracking. Consumers should use external state (e.g. KV or D1)
 *   if job status visibility is required.
 * - `process` stores the handler reference locally. In Cloudflare Workers, queue
 *   consumption is handled via the `queue()` export in the Worker entry point, not
 *   via a long-running polling loop. Call `process` during initialization, then
 *   invoke `handleMessage` from your Worker's queue handler.
 */
export class CloudflareQueueProvider implements QueueProvider {
  private handlers = new Map<string, (job: Job<unknown>) => Promise<void>>();

  constructor(private queues: Record<string, CloudflareQueue>) {}

  supportsQueue(queueName: string): boolean {
    return Boolean(this.queues[queueName]);
  }

  async enqueue<T>(
    queueName: string,
    jobName: string,
    data: T,
    options?: JobOptions,
  ): Promise<string> {
    const queue = this.queues[queueName];
    if (!queue) {
      throw new Error(`Queue binding not found: ${queueName}`);
    }

    const id = crypto.randomUUID();
    const message: QueueMessage<T> = { id, jobName, data, options };

    await queue.send(message, {
      contentType: 'json',
      delaySeconds: options?.delay ? Math.ceil(options.delay / 1000) : undefined,
    });

    return id;
  }

  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void {
    this.handlers.set(queueName, handler as (job: Job<unknown>) => Promise<void>);
  }

  /**
   * Returns null — Cloudflare Queues does not support per-job status queries.
   * Use KV or D1 to persist job state if status tracking is needed.
   */
  async getStatus(_queueName: string, _jobId: string): Promise<Job | null> {
    return null;
  }

  /**
   * Invoke the registered handler for a queue message.
   * Call this from your Worker's `queue()` export handler.
   *
   * @example
   * ```ts
   * export default {
   *   async queue(batch, env) {
   *     for (const msg of batch.messages) {
   *       await queueProvider.handleMessage(batch.queue, msg.body);
   *       msg.ack();
   *     }
   *   }
   * }
   * ```
   */
  async handleMessage<T>(queueName: string, body: QueueMessage<T>): Promise<void> {
    const handler = this.handlers.get(queueName);
    if (!handler) {
      throw new Error(`No handler registered for queue: ${queueName}`);
    }

    const job: Job<T> = {
      id: body.id,
      name: body.jobName,
      data: body.data,
      status: 'active',
    };

    await handler(job as Job<unknown>);
  }
}
