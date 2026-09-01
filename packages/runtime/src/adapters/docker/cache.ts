import Redis from 'ioredis';
import { classifyCacheValue, negativeCacheWireValue } from '../../cache-entry';
import type { CacheEvent, CacheEntry, CacheProvider, CacheSetOptions, UniqueCounterProvider } from '../../interfaces';

const TAG_KEY_PREFIX = 'lumi:tag:';
const INVALIDATE_CHUNK = 500;

export class RedisCacheProvider implements CacheProvider, UniqueCounterProvider {
  private client: Redis;

  onEvent?: (e: CacheEvent) => void;

  constructor(connectionOrUrl: Redis | string) {
    if (typeof connectionOrUrl === 'string') {
      this.client = new Redis(connectionOrUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      if (typeof this.client.on === 'function') {
        this.client.on('error', () => {/* intentionally silent */});
      }
    } else {
      this.client = connectionOrUrl;
    }
  }

  private emit(event: CacheEvent): void {
    this.onEvent?.(event);
  }

  private tagKey(tag: string): string {
    return `${TAG_KEY_PREFIX}${tag}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T>> {
    try {
      await this.ensureConnected();
      const val = await this.client.get(key);
      if (val === null) {
        this.emit({ op: 'getEntry', result: 'miss', backend: 'redis' });
        return { state: 'miss' };
      }
      const classified = classifyCacheValue<T>(JSON.parse(val) as unknown);
      if (classified.state === 'negative') {
        this.emit({ op: 'getEntry', result: 'negative', backend: 'redis' });
      } else if (classified.state === 'hit') {
        this.emit({ op: 'getEntry', result: 'hit', backend: 'redis' });
      } else {
        this.emit({ op: 'getEntry', result: 'unavailable', backend: 'redis' });
      }
      return classified;
    } catch {
      console.warn('[cache] Redis get failed — reporting unavailable');
      this.emit({ op: 'getEntry', result: 'unavailable', backend: 'redis' });
      return { state: 'unavailable' };
    }
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    if (entry.state === 'hit') {
      this.emit({ op: 'get', result: 'hit', backend: 'redis' });
      return entry.value;
    }
    if (entry.state === 'negative') {
      this.emit({ op: 'get', result: 'negative', backend: 'redis' });
    } else if (entry.state === 'unavailable') {
      this.emit({ op: 'get', result: 'unavailable', backend: 'redis' });
    } else {
      this.emit({ op: 'get', result: 'miss', backend: 'redis' });
    }
    return null;
  }

  async set(key: string, value: string, options?: CacheSetOptions): Promise<void> {
    try {
      await this.ensureConnected();
      const pipeline = this.client.pipeline();
      if (options?.ttl) {
        pipeline.setex(key, options.ttl, value);
      } else {
        pipeline.set(key, value);
      }
      if (options?.tags?.length) {
        for (const tag of options.tags) {
          const tagKey = this.tagKey(tag);
          pipeline.sadd(tagKey, key);
          if (options.ttl) {
            pipeline.expire(tagKey, options.ttl);
          }
        }
      }
      await pipeline.exec();
      this.emit({ op: 'set', result: 'ok', backend: 'redis' });
    } catch {
      console.warn('[cache] Redis set failed — skipping cache write');
      this.emit({ op: 'set', result: 'error', backend: 'redis' });
    }
  }

  async setNegative(key: string, options?: { ttl?: number }): Promise<void> {
    await this.set(key, negativeCacheWireValue(), options);
    this.emit({ op: 'setNegative', result: 'ok', backend: 'redis' });
  }

  async delete(key: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.client.del(key);
      this.emit({ op: 'delete', result: 'ok', backend: 'redis' });
    } catch {
      console.warn('[cache] Redis delete failed — skipping cache delete');
      this.emit({ op: 'delete', result: 'error', backend: 'redis' });
    }
  }

  async invalidateByTag(tag: string): Promise<void> {
    try {
      await this.ensureConnected();
      const tagKey = this.tagKey(tag);
      const members = await this.client.smembers(tagKey);
      for (let i = 0; i < members.length; i += INVALIDATE_CHUNK) {
        const chunk = members.slice(i, i + INVALIDATE_CHUNK);
        if (chunk.length > 0) {
          await this.client.del(...chunk);
        }
      }
      await this.client.del(tagKey);
      this.emit({ op: 'invalidateByTag', result: 'ok', backend: 'redis' });
    } catch {
      console.warn('[cache] Redis invalidateByTag failed — skipping purge');
      this.emit({ op: 'invalidateByTag', result: 'error', backend: 'redis' });
    }
  }

  // Counters intentionally do NOT swallow errors (see CacheProvider.increment):
  // a silently-dropped increment corrupts the count, so we let the caller catch
  // and fall back (e.g. to the DB-rollup strategy) instead.
  async increment(key: string, by = 1, opts?: { ttl?: number }): Promise<number> {
    await this.ensureConnected();
    const value = await this.client.incrby(key, by);
    // Set the window TTL only when the key was just created (value === by),
    // so re-incrementing within the window never extends it. EXPIRE ... NX
    // (Redis 7+) is a belt-and-suspenders guard against a concurrent create.
    if (opts?.ttl && value === by) {
      await this.client.expire(key, opts.ttl, 'NX');
    }
    return value;
  }

  async addUnique(key: string, member: string, opts?: { ttl?: number }): Promise<void> {
    await this.ensureConnected();
    const added = await this.client.pfadd(key, member);
    // pfadd returns 1 when the HLL was created/altered; only arm the TTL on the
    // first write so the daily window is not extended by later members.
    if (opts?.ttl && added === 1) {
      await this.client.expire(key, opts.ttl, 'NX');
    }
  }

  async countUnique(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.pfcount(key);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // ignore
    }
  }
}
