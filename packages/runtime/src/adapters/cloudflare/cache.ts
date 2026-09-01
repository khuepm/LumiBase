import { classifyCacheValue, negativeCacheWireValue } from '../../cache-entry';
import type { CacheEvent, CacheEntry, CacheProvider, CacheSetOptions, UniqueCounterProvider } from '../../interfaces';
import { CounterUnavailableError } from '../../interfaces';
import type { DurableObjectNamespaceLike } from './realtime';

/**
 * Minimal KVNamespace interface matching Cloudflare Workers KV API.
 * Declared locally to avoid a hard dependency on @cloudflare/workers-types.
 */
export interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Cloudflare KV-backed CacheProvider.
 *
 * Wraps a Cloudflare Workers KVNamespace binding to implement the
 * CacheProvider interface for edge deployments.
 *
 * Tag index: each tag maps to `tag:{tag}` holding a JSON string array of
 * cache keys (read-modify-write on set). `invalidateByTag` reads the index,
 * deletes each listed key, then deletes the index entry. KV eventual
 * consistency (~60s global propagation) is a lower bound on purge speed;
 * delivery compensates via short `s-maxage`.
 *
 * KV cannot increment atomically, so `increment`/`addUnique`/`countUnique` are
 * delegated to the per-site `PageviewCounter` Durable Object when its namespace
 * binding is present. When the binding is absent (`PAGEVIEW_COUNTER` unset), the
 * counter methods throw {@link CounterUnavailableError} so the caller can fall
 * back to the DB-rollup strategy — get/set/delete are unaffected.
 *
 * Negative-cache note (Req 19.4 / design §21.7 CHỐT 2026-08-01): Workers KV
 * `get` returns `null` on miss (does not throw). Soft failures that surface as
 * `null` collapse to `miss` → safe DB fallback. `unavailable` is only observed
 * when `get` actually throws (infra/runtime exceptions); primarily a Docker/
 * Redis-observable state.
 */
export class CloudflareCacheProvider implements CacheProvider, UniqueCounterProvider {
  onEvent?: (e: CacheEvent) => void;

  constructor(
    private kv: KVNamespace,
    private counterNs?: DurableObjectNamespaceLike,
  ) {}

  private emit(event: CacheEvent): void {
    this.onEvent?.(event);
  }

  private tagIndexKey(tag: string): string {
    return `tag:${tag}`;
  }

  private async readTagIndex(tag: string): Promise<string[]> {
    const raw = await this.kv.get(this.tagIndexKey(tag), 'text');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  private async writeTagIndex(tag: string, keys: string[]): Promise<void> {
    await this.kv.put(this.tagIndexKey(tag), JSON.stringify(keys));
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T>> {
    try {
      const val = await this.kv.get(key, 'json');
      const classified = classifyCacheValue<T>(val);
      if (classified.state === 'negative') {
        this.emit({ op: 'getEntry', result: 'negative', backend: 'kv' });
      } else if (classified.state === 'hit') {
        this.emit({ op: 'getEntry', result: 'hit', backend: 'kv' });
      } else if (classified.state === 'unavailable') {
        this.emit({ op: 'getEntry', result: 'unavailable', backend: 'kv' });
      } else {
        this.emit({ op: 'getEntry', result: 'miss', backend: 'kv' });
      }
      return classified;
    } catch {
      this.emit({ op: 'getEntry', result: 'unavailable', backend: 'kv' });
      return { state: 'unavailable' };
    }
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    if (entry.state === 'hit') {
      this.emit({ op: 'get', result: 'hit', backend: 'kv' });
      return entry.value;
    }
    if (entry.state === 'negative') {
      this.emit({ op: 'get', result: 'negative', backend: 'kv' });
    } else if (entry.state === 'unavailable') {
      this.emit({ op: 'get', result: 'unavailable', backend: 'kv' });
    } else {
      this.emit({ op: 'get', result: 'miss', backend: 'kv' });
    }
    return null;
  }

  async set(key: string, value: string, options?: CacheSetOptions): Promise<void> {
    try {
      await this.kv.put(
        key,
        value,
        options?.ttl ? { expirationTtl: options.ttl } : undefined,
      );
      if (options?.tags?.length) {
        for (const tag of options.tags) {
          const existing = await this.readTagIndex(tag);
          if (!existing.includes(key)) {
            existing.push(key);
            await this.writeTagIndex(tag, existing);
          }
        }
      }
      this.emit({ op: 'set', result: 'ok', backend: 'kv' });
    } catch {
      this.emit({ op: 'set', result: 'error', backend: 'kv' });
    }
  }

  async setNegative(key: string, options?: { ttl?: number }): Promise<void> {
    await this.set(key, negativeCacheWireValue(), options);
    this.emit({ op: 'setNegative', result: 'ok', backend: 'kv' });
  }

  async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key);
      this.emit({ op: 'delete', result: 'ok', backend: 'kv' });
    } catch {
      this.emit({ op: 'delete', result: 'error', backend: 'kv' });
    }
  }

  async invalidateByTag(tag: string): Promise<void> {
    try {
      const keys = await this.readTagIndex(tag);
      await Promise.all(keys.map((k) => this.kv.delete(k)));
      await this.kv.delete(this.tagIndexKey(tag));
      this.emit({ op: 'invalidateByTag', result: 'ok', backend: 'kv' });
    } catch {
      this.emit({ op: 'invalidateByTag', result: 'error', backend: 'kv' });
    }
  }

  /**
   * Counter keys are namespaced `pv:{siteId}:...` so the DO instance can be
   * addressed per site. Extract the siteId (2nd colon-segment) and forward to
   * that site's PageviewCounter DO.
   */
  private stub(key: string) {
    if (!this.counterNs) throw new CounterUnavailableError();
    const siteId = key.split(':')[1] ?? key;
    const id = this.counterNs.idFromName(siteId);
    return this.counterNs.get(id);
  }

  async increment(key: string, by = 1, _opts?: { ttl?: number }): Promise<number> {
    const res = await this.stub(key).fetch('https://internal/incr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, by }),
    });
    const { value } = (await res.json()) as { value: number };
    return value;
  }

  async addUnique(key: string, member: string, opts?: { ttl?: number }): Promise<void> {
    await this.stub(key).fetch('https://internal/pfadd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, member }),
    });
  }

  async countUnique(key: string): Promise<number> {
    const res = await this.stub(key).fetch(
      `https://internal/count?key=${encodeURIComponent(key)}`,
    );
    const { value } = (await res.json()) as { value: number };
    return value;
  }

  /**
   * Drain-and-reset a single site's PageviewCounter DO. Used by the scheduled
   * flush to move counters/uniques into the durable rollup. Absent binding
   * yields empty results (nothing to flush).
   */
  async drainSite(siteId: string): Promise<{
    counters: Array<{ key: string; value: number }>;
    uniques: Array<{ key: string; value: number }>;
  }> {
    if (!this.counterNs) return { counters: [], uniques: [] };
    const id = this.counterNs.idFromName(siteId);
    const res = await this.counterNs.get(id).fetch('https://internal/drain?prefix=');
    return (await res.json()) as {
      counters: Array<{ key: string; value: number }>;
      uniques: Array<{ key: string; value: number }>;
    };
  }
}
