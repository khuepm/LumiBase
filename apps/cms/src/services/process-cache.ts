/**
 * Tiny per-process TTL cache for request-hot values that change rarely and
 * are cheap to recompute (high-load-cache-readiness Req 4; design §6.3).
 *
 * This is deliberately NOT the distributed {@link CacheProvider}: it keeps a
 * single value in the worker/process, so a "burst" of concurrent requests
 * degrades to at most one recompute per process per TTL window rather than
 * one per request. Mirrors the inline pattern already used by
 * `middleware/admin-path-guard.ts` (state read once, 5s TTL), extracted so
 * other hot middleware can reuse it.
 *
 * Time source is injectable for tests; production uses `Date.now`.
 */
export interface ProcessCache<T> {
  /** Return the cached value if fresh, else recompute via `load`, store, return. */
  get(load: () => Promise<T>): Promise<T>;
  /** Drop the cached value so the next `get` recomputes. */
  clear(): void;
}

export interface ProcessCacheOptions<T> {
  /** Fresh-window in milliseconds. */
  ttlMs: number;
  /**
   * Optional predicate: when it returns true for a freshly-loaded value, the
   * value is cached PERMANENTLY (TTL ignored). Used for one-way state flips
   * such as setup `uninitialized → initialized`, which never reverts.
   */
  cachePermanentlyWhen?: (value: T) => boolean;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
}

export function createProcessCache<T>(options: ProcessCacheOptions<T>): ProcessCache<T> {
  const now = options.now ?? (() => Date.now());
  let value: T | undefined;
  let hasValue = false;
  let expiresAt = 0;
  let permanent = false;
  // Coalesce concurrent misses into a single in-flight load.
  let inflight: Promise<T> | null = null;

  return {
    async get(load: () => Promise<T>): Promise<T> {
      if (hasValue && (permanent || now() < expiresAt)) return value as T;
      if (inflight) return inflight;

      inflight = (async () => {
        try {
          const loaded = await load();
          value = loaded;
          hasValue = true;
          if (options.cachePermanentlyWhen?.(loaded)) {
            permanent = true;
          } else {
            expiresAt = now() + options.ttlMs;
          }
          return loaded;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    clear() {
      hasValue = false;
      permanent = false;
      expiresAt = 0;
      value = undefined;
    },
  };
}
