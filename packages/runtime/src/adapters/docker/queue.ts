import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { QueueProvider, Job, JobOptions } from '../../interfaces';

/**
 * BullMQ-backed QueueProvider for Docker/Node.js environments.
 *
 * Uses the existing Redis connection for both queue storage and worker processing.
 * Queues are lazily created and cached by name.
 */
export class BullMQProvider implements QueueProvider {
  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];

  constructor(private connection: Redis) {}

  private getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      this.queues.set(name, new Queue(name, { connection: this.connection as any }));
    }
    return this.queues.get(name)!;
  }

  async enqueue<T>(
    queueName: string,
    jobName: string,
    data: T,
    options?: JobOptions,
  ): Promise<string> {
    const queue = this.getQueue(queueName);
    const job = await queue.add(jobName, data as object, {
      priority: options?.priority === 'high' ? 1 : options?.priority === 'low' ? 3 : 2,
      delay: options?.delay,
      attempts: options?.attempts ?? 3,
      backoff: options?.backoff ?? { type: 'exponential', delay: 1000 },
    });
    return job.id!;
  }

  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void {
    const worker = new Worker(
      queueName,
      async (bullJob) => {
        await handler({
          id: bullJob.id!,
          name: bullJob.name,
          data: bullJob.data as T,
          status: 'active',
        });
      },
      { connection: this.connection as any },
    );
    this.workers.push(worker);
  }

  async getStatus(queueName: string, jobId: string): Promise<Job | null> {
    const queue = this.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      id: job.id!,
      name: job.name,
      data: job.data,
      status: state as Job['status'],
    };
  }

  /**
   * Gracefully close all queues and workers.
   * Call this during application shutdown.
   */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
