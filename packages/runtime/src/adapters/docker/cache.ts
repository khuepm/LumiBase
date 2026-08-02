import Redis from 'ioredis';
import { classifyCacheValue, negativeCacheWireValue } from '../../cache-entry';
import type { CacheEntry, CacheProvider, UniqueCounterProvider } from '../../interfaces';

export class RedisCacheProvider implements CacheProvider, UniqueCounterProvider {
  private client: Redis;

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

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T>> {
    try {
      await this.ensureConnected();
      const val = await this.client.get(key);
      if (val === null) return { state: 'miss' };
      return classifyCacheValue<T>(JSON.parse(val) as unknown);
    } catch {
      console.warn('[cache] Redis get failed — reporting unavailable');
      return { state: 'unavailable' };
    }
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    return entry.state === 'hit' ? entry.value : null;
  }

  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    try {
      await this.ensureConnected();
      if (options?.ttl) {
        await this.client.setex(key, options.ttl, value);
      } else {
        await this.client.set(key, value);
      }
    } catch {
      console.warn('[cache] Redis set failed — skipping cache write');
    }
  }

  async setNegative(key: string, options?: { ttl?: number }): Promise<void> {
    await this.set(key, negativeCacheWireValue(), options);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.client.del(key);
    } catch {
      console.warn('[cache] Redis delete failed — skipping cache delete');
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
