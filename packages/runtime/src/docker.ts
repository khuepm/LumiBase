// @lumibase/runtime/docker — Docker/Node.js adapters.
//
// Deliberately NOT re-exported from the package root: this subtree imports
// `bullmq`, `ioredis`, `@aws-sdk/client-s3`, `meilisearch` and Node built-ins as
// value imports. Pulling it into the Cloudflare Worker bundle broke Worker
// startup outright (see the note at the top of `./index.ts`), so the Worker path
// must never reach this file.
//
// Import it from Node entry points only (`apps/cms/src/serve.ts`, CLI scripts),
// or through an `await import()` on a branch that cannot execute under Workers.
export {
  createDockerRuntime,
  createDockerKeyProvider,
  DockerRealtimeProvider,
  InProcessRealtimeHub,
  getSharedRealtimeHub,
  NoOpEdgeCacheProvider,
  RedisCacheProvider,
  S3StorageProvider,
  PostgresDatabaseProvider,
  MeiliSearchProvider,
  BullMQProvider,
  ImgproxyMediaProcessor,
} from './adapters/docker';
