/**
 * Four-state cache read result (high-load-cache-readiness Req 19.4; design §14.3).
 *
 * Distinguishes a confirmed absence (tombstone) from an unknown key and from a
 * backend failure — the legacy `get()` API collapses all three to `null`.
 */
export type CacheEntry<T> =
  | { state: 'hit'; value: T }
  | { state: 'negative' }
  | { state: 'miss' }
  | { state: 'unavailable' };

/** Wire-format sentinel for a negative-cache (tombstone) entry. */
export const NEGATIVE_CACHE_ENVELOPE = { __lumi: 'neg', v: 1 } as const;

export type NegativeCacheEnvelope = typeof NEGATIVE_CACHE_ENVELOPE;

export function isNegativeCacheEnvelope(value: unknown): value is NegativeCacheEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.__lumi === 'neg' && record.v === 1;
}

export interface CacheSetOptions {
  ttl?: number;
  tags?: string[];
}

export type CacheEvent = {
  op: 'get' | 'set' | 'delete' | 'invalidateByTag' | 'getEntry' | 'setNegative';
  result: 'hit' | 'miss' | 'ok' | 'error' | 'negative' | 'unavailable';
  backend: string;
};

export interface CacheProvider {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  invalidateByTag(tag: string): Promise<void>;
  /** Optional observability hook — CMS may wire to Prometheus (Req 13). */
  onEvent?: (e: CacheEvent) => void;
  /**
   * Atomically increment a counter and return its post-increment value.
   *
   * Unlike get/set (which fail soft and return null on a backend error), a
   * counter that silently reports the wrong value is worse than a thrown error
   * the caller can catch and fall back on — so implementations MUST reject on
   * backend failure rather than swallow it.
   *
   * @param by  amount to add (default 1)
   * @param opts.ttl  seconds; applied only when the key is first created.
   */
  increment(key: string, by?: number, opts?: { ttl?: number }): Promise<number>;
  /**
   * Read that distinguishes hit / negative (tombstone) / miss / unavailable.
   * Legacy `get()` = hit → value, everything else → null.
   */
  getEntry<T>(key: string): Promise<CacheEntry<T>>;
  /**
   * Write a tombstone. The on-wire value is {@link NEGATIVE_CACHE_ENVELOPE}
   * — never `null` or `""`, which both adapters treat as falsy.
   */
  setNegative(key: string, options?: { ttl?: number }): Promise<void>;
}

/**
 * Optional capability for approximate unique-cardinality counting (e.g. unique
 * visitors). Not every backend can do this atomically — Cloudflare KV has no
 * equivalent — so it is a separate interface. Callers must feature-detect with
 * `'addUnique' in provider` and fall back to a durable COUNT DISTINCT when a
 * provider does not implement it.
 */
export interface UniqueCounterProvider {
  /** Add a member to the cardinality set for `key`. `ttl` set only on create. */
  addUnique(key: string, member: string, opts?: { ttl?: number }): Promise<void>;
  /** Approximate number of distinct members added under `key`. */
  countUnique(key: string): Promise<number>;
}

/**
 * Optional capability: a bounded set of string members that many writers can
 * add to concurrently without losing each other's members (#864).
 *
 * The plain `get`/`set` pair cannot do this — appending to a JSON list stored
 * under one key is a read-modify-write, and two concurrent writers each drop
 * the other's member. Implementations use a primitive whose adds commute
 * instead: a Redis sorted set (`ZADD`), one Workers KV key per member, or a
 * synchronous in-process map.
 *
 * Callers feature-detect with {@link hasMemberSet}. The set lives in its own
 * key namespace, so `get(key)` / `delete(key)` never see it.
 */
export interface MemberSetProvider {
  /**
   * Add `member` to the set at `key`. Re-adding an existing member refreshes
   * it rather than duplicating it.
   *
   * @param opts.ttl    seconds; the set (Redis) or the member (KV) expires
   *                    after this long without another add.
   * @param opts.limit  keep at most this many members, dropping the oldest.
   *                    Enforced on write where the backend can trim
   *                    atomically (Redis, memory) and on read otherwise (KV).
   */
  addMember(key: string, member: string, opts?: { ttl?: number; limit?: number }): Promise<void>;
  /**
   * Read the newest `opts.limit` members (all when omitted), oldest first,
   * without removing them. The caller acts on them, then calls `ack()` to
   * remove exactly what it read — so a caller that fails before `ack()`
   * leaves the set intact for a retry, and a member re-added after the read
   * survives the ack.
   */
  readMembers(key: string, opts?: { limit?: number }): Promise<MemberBatch>;
}

/** Members read by {@link MemberSetProvider.readMembers}. */
export interface MemberBatch {
  members: string[];
  /**
   * Remove the members read here, unless they were re-added since. Pass a
   * subset to acknowledge only those and keep the rest for the next read —
   * e.g. the URLs a CDN purge reached, not the ones it refused (#864).
   * Members not in this batch are ignored.
   */
  ack(members?: readonly string[]): Promise<void>;
}

/** True when `cache` implements {@link MemberSetProvider}. */
export function hasMemberSet<T extends object>(cache: T): cache is T & MemberSetProvider {
  const candidate = cache as Partial<MemberSetProvider>;
  return typeof candidate.addMember === 'function' && typeof candidate.readMembers === 'function';
}

/** Thrown when an atomic-counter backend is not wired for the active runtime. */
export class CounterUnavailableError extends Error {
  constructor(message = 'atomic counter backend unavailable') {
    super(message);
    this.name = 'CounterUnavailableError';
  }
}
