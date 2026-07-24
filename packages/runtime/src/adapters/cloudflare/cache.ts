import type { CacheProvider, UniqueCounterProvider } from '../../interfaces';
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
 * KV cannot increment atomically, so `increment`/`addUnique`/`countUnique` are
 * delegated to the per-site `PageviewCounter` Durable Object when its namespace
 * binding is present. When the binding is absent (`PAGEVIEW_COUNTER` unset), the
 * counter methods throw {@link CounterUnavailableError} so the caller can fall
 * back to the DB-rollup strategy — get/set/delete are unaffected.
 */
export class CloudflareCacheProvider implements CacheProvider, UniqueCounterProvider {
  constructor(
    private kv: KVNamespace,
    private counterNs?: DurableObjectNamespaceLike,
  ) {}

  async get<T = string>(key: string): Promise<T | null> {
    return this.kv.get(key, 'json') as Promise<T | null>;
  }

  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    await this.kv.put(
      key,
      value,
      options?.ttl ? { expirationTtl: options.ttl } : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
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

  async addUnique(key: string, member: string, _opts?: { ttl?: number }): Promise<void> {
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
