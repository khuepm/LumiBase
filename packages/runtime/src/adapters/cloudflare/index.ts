import type { RuntimeContext } from '../../interfaces';
import { CloudflareCacheProvider, type KVNamespace } from './cache';
import { CloudflareStorageProvider, type R2Bucket } from './storage';
import { CloudflareDatabaseProvider, type Hyperdrive } from './database';
import { CloudflareSearchProvider } from './search';
import { CloudflareQueueProvider, type CloudflareQueue } from './queue';
import { CloudflareMediaProcessor } from './media';
import { createCloudflareKeyProvider } from './keys';
import { CloudflareRealtimeProvider, type DurableObjectNamespaceLike } from './realtime';

export { CloudflareRealtimeProvider } from './realtime';
export { CloudflareCacheProvider } from './cache';
export { CloudflareStorageProvider } from './storage';
export { CloudflareDatabaseProvider } from './database';
export { CloudflareSearchProvider } from './search';
export { CloudflareQueueProvider } from './queue';
export { CloudflareMediaProcessor } from './media';
export { createCloudflareKeyProvider } from './keys';

/**
 * Expected Cloudflare Worker environment bindings.
 */
interface CloudflareEnv {
  CONFIG_CACHE: KVNamespace;
  MEDIA: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  MEILISEARCH_HOST: string;
  MEILISEARCH_API_KEY: string;
  // Either a pre-built map (legacy) or individual Queue producer bindings
  // (e.g. REALTIME_QUEUE) wired in wrangler.toml. See collectQueues().
  QUEUES?: Record<string, CloudflareQueue>;
  REALTIME_QUEUE?: CloudflareQueue;
  MEDIA_BASE_URL?: string;
  /** SiteRoom Durable Object namespace — realtime fan-out hub. */
  SITE_ROOM?: DurableObjectNamespaceLike;
}

/**
 * Cloudflare Queue producer bindings are flat env entries (one per queue),
 * not a nested `QUEUES` object. Collect any queue-shaped bindings into the
 * record the QueueProvider expects, keyed by both their binding name and a
 * generic `_health`/`default` alias so callers that don't know the concrete
 * binding name (e.g. the health probe) still resolve a queue.
 */
function collectQueues(env: Record<string, unknown>): Record<string, CloudflareQueue> {
  const cfEnv = env as unknown as CloudflareEnv;
  if (cfEnv.QUEUES) return cfEnv.QUEUES;

  const queues: Record<string, CloudflareQueue> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value && typeof (value as { send?: unknown }).send === 'function') {
      queues[key] = value as CloudflareQueue;
    }
  }

  // Provide generic aliases pointing at the first available queue so health
  // probes and queue-agnostic callers work without hardcoding a binding name.
  const first = Object.values(queues)[0];
  if (first) {
    queues._health ??= first;
    queues.default ??= first;
  }
  return queues;
}

/**
 * Creates a RuntimeContext configured for Cloudflare Workers.
 *
 * Expects the Worker's `env` bindings to include KV, R2, Hyperdrive,
 * and MeiliSearch configuration.
 */
export function createCloudflareRuntime(env: Record<string, unknown>): RuntimeContext {
  const cfEnv = env as unknown as CloudflareEnv;

  return {
    cache: new CloudflareCacheProvider(cfEnv.CONFIG_CACHE),
    storage: new CloudflareStorageProvider(cfEnv.MEDIA),
    database: new CloudflareDatabaseProvider(cfEnv.HYPERDRIVE),
    search: new CloudflareSearchProvider(
      cfEnv.MEILISEARCH_HOST,
      cfEnv.MEILISEARCH_API_KEY,
    ),
    queue: new CloudflareQueueProvider(collectQueues(env)),
    media: new CloudflareMediaProcessor(cfEnv.MEDIA_BASE_URL ?? ''),
    keys: createCloudflareKeyProvider(env),
    realtime: new CloudflareRealtimeProvider(cfEnv.SITE_ROOM),
    runtime: 'cloudflare',
  };
}
