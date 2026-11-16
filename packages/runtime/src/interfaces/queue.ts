export interface JobOptions {
  priority?: 'high' | 'normal' | 'low';
  delay?: number;
  attempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  status: 'waiting' | 'active' | 'completed' | 'failed';
}

export interface QueueProvider {
  /** Static routing check for runtimes with explicitly provisioned queues. */
  supportsQueue?(queueName: string): boolean;
  enqueue<T>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<string>;
  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void;
  getStatus(queueName: string, jobId: string): Promise<Job | null>;
}
