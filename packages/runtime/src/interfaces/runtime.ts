import type { CacheProvider } from './cache';
import type { StorageProvider } from './storage';
import type { DatabaseProvider } from './database';
import type { SearchProvider } from './search';
import type { QueueProvider } from './queue';
import type { MediaProcessor } from './media';
import type { KeyProvider } from './keys';

export interface RuntimeContext {
  cache: CacheProvider;
  storage: StorageProvider;
  database: DatabaseProvider;
  search: SearchProvider;
  queue: QueueProvider;
  media: MediaProcessor;
  keys: KeyProvider;
  runtime: 'cloudflare' | 'docker';
}
