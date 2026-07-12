export interface CacheProvider {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
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

/** Thrown when an atomic-counter backend is not wired for the active runtime. */
export class CounterUnavailableError extends Error {
  constructor(message = 'atomic counter backend unavailable') {
    super(message);
    this.name = 'CounterUnavailableError';
  }
}
