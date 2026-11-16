import type {
  CacheEntry,
  CacheEvent,
  CacheProvider,
  CacheSetOptions,
  MemberSetProvider,
} from './interfaces/cache';
import { classifyCacheValue, negativeCacheWireValue } from './cache-entry';

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

interface MemorySet {
  /** Insertion order is age order: the first member is the oldest. */
  members: Set<string>;
  expiresAt: number | null;
}

/**
 * In-process CacheProvider with LRU eviction, TTL, tag indexing, and
 * negative-cache support (high-load-cache-readiness Req 7.6 / 19.4).
 */
export class MemoryCacheProvider implements CacheProvider, MemberSetProvider {
  private readonly store = new Map<string, MemoryEntry>();
  /** Member sets live apart from `store`, so `get`/`delete` never see them. */
  private readonly sets = new Map<string, MemorySet>();
  private readonly tagIndex = new Map<string, Set<string>>();

  onEvent?: (e: CacheEvent) => void;

  constructor(private readonly maxEntries = 10_000) {}

  private emit(event: CacheEvent): void {
    this.onEvent?.(event);
  }

  private touch(key: string, entry: MemoryEntry): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  private readRaw(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.removeKey(key);
      return null;
    }
    this.touch(key, entry);
    return entry.value;
  }

  private removeKey(key: string): void {
    this.store.delete(key);
    for (const [tag, keys] of this.tagIndex) {
      keys.delete(key);
      if (keys.size === 0) this.tagIndex.delete(tag);
    }
  }

  private indexTags(key: string, tags: string[] | undefined): void {
    if (!tags?.length) return;
    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  private evictIfNeeded(incomingKey: string): void {
    if (this.store.size < this.maxEntries || this.store.has(incomingKey)) return;
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) this.removeKey(oldest);
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    return entry.state === 'hit' ? entry.value : null;
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T>> {
    const raw = this.readRaw(key);
    if (raw === null) {
      this.emit({ op: 'getEntry', result: 'miss', backend: 'memory' });
      return { state: 'miss' };
    }
    try {
      const classified = classifyCacheValue<T>(JSON.parse(raw) as unknown);
      if (classified.state === 'negative') {
        this.emit({ op: 'getEntry', result: 'negative', backend: 'memory' });
      } else if (classified.state === 'hit') {
        this.emit({ op: 'getEntry', result: 'hit', backend: 'memory' });
      } else {
        this.emit({ op: 'getEntry', result: 'unavailable', backend: 'memory' });
      }
      return classified;
    } catch {
      this.emit({ op: 'getEntry', result: 'unavailable', backend: 'memory' });
      return { state: 'unavailable' };
    }
  }

  async set(key: string, value: string, options?: CacheSetOptions): Promise<void> {
    this.evictIfNeeded(key);
    this.store.set(key, {
      value,
      expiresAt: options?.ttl ? Date.now() + options.ttl * 1000 : null,
    });
    this.touch(key, this.store.get(key)!);
    this.indexTags(key, options?.tags);
    this.emit({ op: 'set', result: 'ok', backend: 'memory' });
  }

  async setNegative(key: string, options?: { ttl?: number }): Promise<void> {
    await this.set(key, negativeCacheWireValue(), options);
    this.emit({ op: 'setNegative', result: 'ok', backend: 'memory' });
  }

  async delete(key: string): Promise<void> {
    this.removeKey(key);
    this.emit({ op: 'delete', result: 'ok', backend: 'memory' });
  }

  async invalidateByTag(tag: string): Promise<void> {
    const keys = this.tagIndex.get(tag);
    if (!keys?.size) {
      this.emit({ op: 'invalidateByTag', result: 'ok', backend: 'memory' });
      return;
    }
    for (const key of [...keys]) {
      this.removeKey(key);
    }
    this.tagIndex.delete(tag);
    this.emit({ op: 'invalidateByTag', result: 'ok', backend: 'memory' });
  }

  async increment(key: string, by = 1, opts?: { ttl?: number }): Promise<number> {
    const raw = this.readRaw(key);
    const current = raw ? Number(JSON.parse(raw)) : 0;
    const next = (Number.isFinite(current) ? current : 0) + by;
    await this.set(key, JSON.stringify(next), raw ? undefined : opts);
    return next;
  }

  // Synchronous between the awaits, so concurrent adds cannot interleave.
  async addMember(key: string, member: string, opts?: { ttl?: number; limit?: number }): Promise<void> {
    const now = Date.now();
    let set = this.sets.get(key);
    if (!set || (set.expiresAt !== null && set.expiresAt <= now)) {
      set = { members: new Set(), expiresAt: null };
      this.sets.set(key, set);
    }
    set.members.delete(member);
    set.members.add(member);
    if (opts?.limit !== undefined) {
      for (const oldest of set.members) {
        if (set.members.size <= opts.limit) break;
        set.members.delete(oldest);
      }
    }
    if (opts?.ttl) set.expiresAt = now + opts.ttl * 1000;
  }

  async drainMembers(key: string, opts?: { limit?: number }): Promise<string[]> {
    const set = this.sets.get(key);
    this.sets.delete(key);
    if (!set || (set.expiresAt !== null && set.expiresAt <= Date.now())) return [];
    const members = [...set.members];
    if (opts?.limit === undefined) return members;
    return opts.limit > 0 ? members.slice(-opts.limit) : [];
  }
}
