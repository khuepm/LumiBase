import { classifyCacheValue, negativeCacheWireValue } from '../../cache-entry';
import type {
  CacheEvent,
  CacheEntry,
  CacheProvider,
  CacheSetOptions,
  MemberSetProvider,
  UniqueCounterProvider,
} from '../../interfaces';
import { CounterUnavailableError } from '../../interfaces';
import type { DurableObjectNamespaceLike } from './realtime';

/**
 * Minimal KVNamespace interface matching Cloudflare Workers KV API.
 * Declared locally to avoid a hard dependency on @cloudflare/workers-types.
 */
export interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Present on every real Workers KV binding; optional here only so test
   * doubles that never touch member sets need not implement it.
   */
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListResult>;
}

export interface KVListResult {
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  list_complete: boolean;
  cursor?: string;
}

/** Namespace for {@link MemberSetProvider} keys: `lumi:set:{key}:{sha256(member)}`. */
const SET_KEY_PREFIX = 'lumi:set:';
/** Workers KV rejects an `expirationTtl` below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;
/** Upper bound on keys one drain scans, to stay inside per-invocation KV limits. */
const SET_DRAIN_SCAN_LIMIT = 1000;

interface MemberMetadata {
  m: string;
  t: number;
}

function isMemberMetadata(value: unknown): value is MemberMetadata {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.m === 'string' && typeof record.t === 'number';
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
/** Matches `pv:` (views) and `pvu:` (uniques); the DO drains with `LIKE prefix%`. */
const PAGEVIEW_DRAIN_PREFIX = 'pv';

export class CloudflareCacheProvider implements CacheProvider, UniqueCounterProvider, MemberSetProvider {
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
   * Member sets (#864). KV has no atomic append, so each member is its own key
   * — `lumi:set:{key}:{sha256(member)}` — carrying the member and its write
   * time in list metadata. Concurrent adds of different members write
   * different keys and cannot overwrite each other; re-adding a member
   * rewrites its own key, which deduplicates and refreshes it.
   *
   * `limit` cannot be enforced on write without a read-modify-write, so it is
   * enforced on read: {@link drainMembers} returns the newest `limit`. Members
   * beyond the bound expire through `ttl`.
   */
  async addMember(key: string, member: string, opts?: { ttl?: number; limit?: number }): Promise<void> {
    const memberKey = `${SET_KEY_PREFIX}${key}:${await sha256Hex(member)}`;
    const metadata: MemberMetadata = { m: member, t: Date.now() };
    await this.kv.put(memberKey, member, {
      metadata,
      ...(opts?.ttl ? { expirationTtl: Math.max(opts.ttl, KV_MIN_TTL_SECONDS) } : {}),
    });
  }

  /**
   * List the members, return the newest `limit`, and delete the keys of the
   * members returned. KV `list` is eventually consistent, so a member added
   * moments before the drain may not be listed yet; it stays in the set for
   * the next drain rather than being lost. Members past `limit` are left to
   * expire on their TTL, keeping the delete fan-out bounded.
   */
  async drainMembers(key: string, opts?: { limit?: number }): Promise<string[]> {
    if (!this.kv.list) throw new Error('KV binding does not support list()');
    const prefix = `${SET_KEY_PREFIX}${key}:`;
    const entries: Array<{ name: string; member: string; t: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({
        prefix,
        limit: SET_DRAIN_SCAN_LIMIT - entries.length,
        ...(cursor ? { cursor } : {}),
      });
      for (const k of page.keys) {
        if (isMemberMetadata(k.metadata)) entries.push({ name: k.name, member: k.metadata.m, t: k.metadata.t });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && entries.length < SET_DRAIN_SCAN_LIMIT);

    entries.sort((a, b) => a.t - b.t);
    const limit = opts?.limit;
    const drained = limit === undefined ? entries : limit > 0 ? entries.slice(-limit) : [];
    await Promise.all(drained.map((e) => this.kv.delete(e.name)));
    return drained.map((e) => e.member);
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

  async increment(key: string, by = 1, opts?: { ttl?: number }): Promise<number> {
    const res = await this.stub(key).fetch('https://internal/incr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, by, ...(opts?.ttl ? { ttl: opts.ttl } : {}) }),
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
   *
   * Only pageview keys (`pv:` and `pvu:`) are drained. The same DO also holds
   * every other `increment()` counter for the site — rate-limit windows,
   * decision quotas, decision refusal dedup (`dra:`) — which expire through the
   * TTL forwarded by `increment` (the DO prunes expired rows), not through this
   * drain.
   */
  async drainSite(siteId: string): Promise<{
    counters: Array<{ key: string; value: number }>;
    uniques: Array<{ key: string; value: number }>;
  }> {
    if (!this.counterNs) return { counters: [], uniques: [] };
    const id = this.counterNs.idFromName(siteId);
    const res = await this.counterNs.get(id).fetch(`https://internal/drain?prefix=${PAGEVIEW_DRAIN_PREFIX}`);
    return (await res.json()) as {
      counters: Array<{ key: string; value: number }>;
      uniques: Array<{ key: string; value: number }>;
    };
  }
}
