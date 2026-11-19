import type { CacheProvider } from './cache';
import type { EdgeCacheProvider } from './edge-cache';
import type { StorageProvider } from './storage';
import type { DatabaseProvider } from './database';
import type { SearchProvider } from './search';
import type { QueueProvider } from './queue';
import type { MediaProcessor } from './media';
import type { KeyProvider } from './keys';
import type { RealtimeProvider } from './realtime';
import type { RateLimiterProvider } from './rate-limiter';
import type { ClamdClient } from './clamd';

export interface RuntimeContext {
  cache: CacheProvider;
  /** Distributed fixed-window rate limiter (Redis / cache.increment / memory). */
  rateLimiter: RateLimiterProvider;
  edgeCache: EdgeCacheProvider;
  storage: StorageProvider;
  database: DatabaseProvider;
  search: SearchProvider;
  queue: QueueProvider;
  media: MediaProcessor;
  keys: KeyProvider;
  realtime: RealtimeProvider;
  /** Native ClamAV client; Docker only, when `CLAMD_HOST` is configured (#707). */
  clamd?: ClamdClient;
  runtime: 'cloudflare' | 'docker';
}
