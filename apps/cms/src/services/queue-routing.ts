import type { QueueProvider } from '@lumibase/runtime';

/**
 * True when `queue` can deliver jobs to the logical queue `name`.
 *
 * Runtimes with explicitly provisioned queues (Cloudflare Workers: one producer
 * binding per queue) report missing bindings through `supportsQueue`. Providers
 * without that method (Docker/BullMQ creates queues on demand) accept any name.
 * Callers use this to fall back to their inline path instead of enqueueing a
 * job that throws `Queue binding not found` and leaves a `pending` row behind
 * (B118).
 */
export function queueAccepts(queue: QueueProvider | undefined | null, name: string): queue is QueueProvider {
  return !!queue && queue.supportsQueue?.(name) !== false;
}
