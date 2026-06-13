import Redis from 'ioredis';
import type { CacheProvider } from '../../interfaces';

export class RedisCacheProvider implements CacheProvider {
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

  async get<T = string>(key: string): Promise<T | null> {
    try {
      await this.ensureConnected();
      const val = await this.client.get(key);
      return val ? (JSON.parse(val) as T) : null;
    } catch {
      console.warn('[cache] Redis get failed — skipping cache read');
      return null;
    }
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

  async delete(key: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.client.del(key);
    } catch {
      console.warn('[cache] Redis delete failed — skipping cache delete');
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // ignore
    }
  }
}
