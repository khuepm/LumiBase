import Redis from 'ioredis';
import type { RuntimeContext } from '../../interfaces';
import { RedisCacheProvider } from './cache';
import { NoOpEdgeCacheProvider } from './edge-cache';
import { S3StorageProvider } from './storage';
import { PostgresDatabaseProvider } from './database';
import { MeiliSearchProvider } from './search';
import { BullMQProvider } from './queue';
import { ImgproxyMediaProcessor } from './media';
import { createDockerKeyProvider } from './keys';
import { DockerRealtimeProvider, getSharedRealtimeHub } from './realtime';
import { RedisRateLimiter } from '../redis-rate-limiter';

export {
  DockerRealtimeProvider,
  InProcessRealtimeHub,
  getSharedRealtimeHub,
} from './realtime';
export { RedisCacheProvider } from './cache';
export { NoOpEdgeCacheProvider } from './edge-cache';
export { S3StorageProvider } from './storage';
export { PostgresDatabaseProvider } from './database';
export { MeiliSearchProvider } from './search';
export { BullMQProvider } from './queue';
export { ImgproxyMediaProcessor } from './media';
export { createDockerKeyProvider } from './keys';
export { RedisRateLimiter } from '../redis-rate-limiter';

/**
 * Creates a RuntimeContext configured for Docker/Node.js environments.
 *
 * Reads connection details from environment variables and instantiates
 * Redis, S3/MinIO, PostgreSQL, MeiliSearch, BullMQ, and Imgproxy adapters.
 */
export function createDockerRuntime(env: Record<string, unknown>): RuntimeContext {
  const redisUrl = (env.REDIS_URL as string) || 'redis://localhost:6379';
  const databaseUrl = (env.DATABASE_URL as string) || '';
  const s3Endpoint = (env.S3_ENDPOINT as string) || 'http://localhost:9000';
  const s3AccessKey = (env.S3_ACCESS_KEY as string) || '';
  const s3SecretKey = (env.S3_SECRET_KEY as string) || '';
  const s3Bucket = (env.S3_BUCKET as string) || 'lumibase-media';
  const meiliHost = (env.MEILISEARCH_HOST as string) || 'http://localhost:7700';
  const meiliKey = (env.MEILISEARCH_API_KEY as string) || undefined;
  const imgproxyUrl = (env.IMGPROXY_URL as string) || 'http://localhost:8080';
  const imgproxyKey = (env.IMGPROXY_KEY as string) || '';
  const imgproxySalt = (env.IMGPROXY_SALT as string) || '';

  // Shared Redis connection for cache and queue.
  // maxRetriesPerRequest:0 + enableOfflineQueue:false ensures that when Redis
  // is unreachable (e.g. Wrangler sandbox blocks TCP connections to localhost),
  // operations fail immediately instead of hanging for ~10 s across 20 retries.
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  // Prevent unhandled 'error' events from crashing the process/worker when
  // Redis is temporarily unavailable; errors are handled per-operation in
  // RedisCacheProvider and BullMQProvider.
  redis.on('error', () => {/* intentionally silent — handled per-operation */});

  return {
    cache: new RedisCacheProvider(redis),
    rateLimiter: new RedisRateLimiter(redis),
    edgeCache: new NoOpEdgeCacheProvider(),
    storage: new S3StorageProvider({
      endpoint: s3Endpoint,
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      bucket: s3Bucket,
    }),
    database: new PostgresDatabaseProvider(databaseUrl),
    search: new MeiliSearchProvider(meiliHost, meiliKey),
    queue: new BullMQProvider(redis),
    media: new ImgproxyMediaProcessor(
      imgproxyUrl,
      imgproxyKey,
      imgproxySalt,
      `${s3Endpoint}/${s3Bucket}`,
    ),
    keys: createDockerKeyProvider(env),
    realtime: new DockerRealtimeProvider(getSharedRealtimeHub()),
    runtime: 'docker',
  };
}
