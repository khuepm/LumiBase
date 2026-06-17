import type { RuntimeContext } from '../../interfaces';
import { CloudflareCacheProvider, type KVNamespace } from './cache';
import { CloudflareStorageProvider, type R2Bucket } from './storage';
import { CloudflareDatabaseProvider, type Hyperdrive } from './database';
import { CloudflareSearchProvider } from './search';
import { CloudflareQueueProvider, type CloudflareQueue } from './queue';
import { CloudflareMediaProcessor } from './media';
import { createCloudflareKeyProvider } from './keys';

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
  QUEUES?: Record<string, CloudflareQueue>;
  MEDIA_BASE_URL?: string;
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
    queue: new CloudflareQueueProvider(cfEnv.QUEUES ?? {}),
    media: new CloudflareMediaProcessor(cfEnv.MEDIA_BASE_URL ?? ''),
    keys: createCloudflareKeyProvider(env),
    runtime: 'cloudflare',
  };
}
