import type { CacheEntry, CacheProvider, CacheSetOptions } from './interfaces/cache';
import { classifyCacheValue, negativeCacheWireValue } from './cache-entry';

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * In-process CacheProvider with TTL + negative-cache support.
 * Used as a test double and as the LRU stand-in until task 8.4 lands a
 * bounded eviction variant (high-load-cache-readiness Req 7.6 / 19.4).
 */
export class MemoryCacheProvider implements CacheProvider {
  private readonly store = new Map<string, MemoryEntry>();

  constructor(private readonly maxEntries = 10_000) {}

  private readRaw(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    return entry.state === 'hit' ? entry.value : null;
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T>> {
    const raw = this.readRaw(key);
    if (raw === null) return { state: 'miss' };
    try {
      return classifyCacheValue<T>(JSON.parse(raw) as unknown);
    } catch {
      return { state: 'unavailable' };
    }
  }

  async set(key: string, value: string, options?: CacheSetOptions): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: options?.ttl ? Date.now() + options.ttl * 1000 : null,
    });
  }

  async setNegative(key: string, options?: { ttl?: number }): Promise<void> {
    await this.set(key, negativeCacheWireValue(), options);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async increment(key: string, by = 1, opts?: { ttl?: number }): Promise<number> {
    const raw = this.readRaw(key);
    const current = raw ? Number(JSON.parse(raw)) : 0;
    const next = (Number.isFinite(current) ? current : 0) + by;
    await this.set(key, JSON.stringify(next), raw ? undefined : opts);
    return next;
  }
}
