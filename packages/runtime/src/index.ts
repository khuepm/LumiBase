// @lumibase/runtime — Runtime abstraction layer
//
// THIS ENTRY POINT MUST STAY SAFE TO BUNDLE INTO A CLOUDFLARE WORKER.
//
// Everything reachable from here is either adapter-free or Cloudflare-only.
// The Docker adapters live behind the `@lumibase/runtime/docker` subpath, and
// `createRuntime` (which branches between the two) behind
// `@lumibase/runtime/node`, because re-exporting them here put `bullmq`,
// `ioredis`, `@aws-sdk/client-s3` and `meilisearch` into the Worker bundle even
// though the Worker never uses them.
//
// That was not merely wasteful. BullMQ 6 added a Postgres backend whose
// `postgres/sql-loader.js` resolves its own directory at MODULE TOP LEVEL and
// throws `Could not determine sql-loader directory path` when there is no
// `__dirname` and no `file:///` stack frame — exactly the case inside a bundled
// Worker. So merely *importing* the barrel made the Worker throw on startup and
// Cloudflare rejected every deploy (validation error 10021). `wrangler deploy
// --dry-run` bundles without instantiating, so the build stayed green.
//
// Rule of thumb when adding an export here: if the module it comes from (or
// anything it imports) needs a Node built-in or a Node-only package as a VALUE
// import, it belongs in a subpath, not in this file. `import type` is fine —
// types are erased.
export * from './interfaces';
export { createCloudflareRuntime, createCloudflareKeyProvider } from './adapters/cloudflare';
export { CloudflareRealtimeProvider, CloudflareEdgeCacheProvider } from './adapters/cloudflare';
export {
  EnvKeyProvider,
  collectKeys,
  resolveActiveKeyId,
} from './adapters/shared-keys';
export { MemoryCacheProvider } from './memory-cache';
export { MemoryRateLimiter } from './memory-rate-limiter';
export { RedisRateLimiter } from './adapters/redis-rate-limiter';
export { CacheBackedRateLimiter } from './adapters/cache-rate-limiter';
export { createNegativeCache, createSwrCache, withProcessCache } from './cache-helpers';
export type {
  NegativeCache,
  NegativeCacheOptions,
  ProcessCacheEntry,
  ProcessCacheOptions,
  ProcessCacheStore,
  SwrCache,
  SwrCacheEntry,
  SwrCacheOptions,
} from './cache-helpers';
export { classifyCacheValue, negativeCacheWireValue } from './cache-entry';
export {
  EDGE_URL_INDEX_LIMIT,
  edgeUrlIndexKey,
  purgeEdgeByTag,
  recordEdgeUrl,
} from './edge-url-index';
export type { CloudflareZonePurgeConfig } from './adapters/cloudflare/edge-cache';
// `./leader-lock` imports ioredis and node:crypto as VALUES, so it is a third
// route into the Worker bundle independent of the Docker adapters. It is
// exported from `@lumibase/runtime/node` instead.
