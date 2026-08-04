import type { CacheProvider } from './interfaces/cache';

/** Wire format for {@link createSwrCache} entries stored in CacheProvider. */
export interface SwrCacheEntry<T> {
  v: T;
  /** Milliseconds since epoch when the entry becomes stale (soft TTL). */
  softExpiresAt: number;
}

export interface SwrCacheOptions<T> {
  cache: CacheProvider;
  /** Seconds after write before serving stale + background refresh. */
  softTtl: number;
  /** Seconds before the backend entry expires and reads block on recompute. */
  hardTtl: number;
  compute: (key: string) => Promise<T>;
  /**
   * Hook for background refresh (e.g. `ctx.waitUntil` on Workers). Defaults to
   * fire-and-forget when omitted.
   */
  schedule?: (p: Promise<unknown>) => void;
}

export interface SwrCache<T> {
  get(key: string): Promise<T>;
}

/**
 * Single-flight + stale-while-revalidate cache helper (design §5.2).
 *
 * **Scope:** in-flight coalescing is per-process instance only. Multiple
 * instances may still recompute the same key in parallel — acceptable because
 * herd is reduced from N_requests to N_instances.
 */
export function createSwrCache<T>(opts: SwrCacheOptions<T>): SwrCache<T> {
  const inflight = new Map<string, Promise<T>>();
  const schedule = opts.schedule ?? ((p: Promise<unknown>) => {
    void p.catch(() => undefined);
  });

  async function recompute(key: string): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await opts.compute(key);
        const entry: SwrCacheEntry<T> = {
          v: value,
          softExpiresAt: Date.now() + opts.softTtl * 1000,
        };
        await opts.cache.set(key, JSON.stringify(entry), { ttl: opts.hardTtl });
        return value;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, promise);
    return promise;
  }

  return {
    async get(key: string): Promise<T> {
      const raw = await opts.cache.get<string | SwrCacheEntry<T>>(key);
      if (raw !== null) {
        try {
          const parsed: SwrCacheEntry<T> =
            typeof raw === 'string' ? (JSON.parse(raw) as SwrCacheEntry<T>) : raw;
          if (
            parsed &&
            typeof parsed === 'object' &&
            'v' in parsed &&
            typeof parsed.softExpiresAt === 'number'
          ) {
            const now = Date.now();
            if (now < parsed.softExpiresAt) {
              return parsed.v;
            }
            const refresh = recompute(key);
            schedule(refresh);
            return parsed.v;
          }
        } catch {
          // Corrupt entry — fall through to blocking recompute.
        }
      }
      return recompute(key);
    },
  };
}

export interface NegativeCacheOptions {
  cache: CacheProvider;
  /** Base TTL in seconds (before jitter). */
  ttl: number;
  /** Fraction of ttl used as ± jitter. Default 0.2 → actual TTL ∈ [0.8·ttl, 1.2·ttl]. */
  jitterRatio?: number;
  /** Optional RNG for tests; defaults to Math.random. */
  random?: () => number;
  /** Fired on tombstone hit (observability). */
  onNegativeHit?: (key: string) => void;
  /** Fired when a tombstone is written. */
  onNegativeWrite?: (key: string) => void;
}

export interface NegativeCache {
  /**
   * Resolve a key through negative cache.
   *
   * - `negative` → return null (no load)
   * - `hit` with value → return value
   * - `miss` → call load; null result → write tombstone
   * - `unavailable` → call load WITHOUT writing a tombstone (Req 19.9)
   *
   * Intentionally does NOT coalesce concurrent loads (no single-flight):
   * single-flight (§5.2) protects hot keys that many callers share; penetration
   * attackers use *distinct* keys, so coalescing would not help and would hide
   * load amplification. Compose with `createSwrCache` inside `load` if both are
   * needed on a hot positive key.
   */
  resolve<T>(key: string, load: () => Promise<T | null>): Promise<T | null>;
  /** Drop a tombstone after the resource is created (Req 19.7). */
  forget(key: string): Promise<void>;
  /** Compute the jittered TTL that would be used for the next write. */
  jitteredTtl(): number;
}

/**
 * Create a negative-cache (tombstone) helper around a CacheProvider.
 *
 * @see high-load-cache-readiness design §14.4
 */
export function createNegativeCache(opts: NegativeCacheOptions): NegativeCache {
  const jitterRatio = opts.jitterRatio ?? 0.2;
  const random = opts.random ?? Math.random;

  const jitteredTtl = (): number => {
    if (opts.ttl <= 0) return 0;
    const delta = opts.ttl * jitterRatio;
    const raw = opts.ttl + (random() * 2 - 1) * delta;
    return Math.max(1, Math.round(raw));
  };

  return {
    jitteredTtl,
    async resolve<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
      const entry = await opts.cache.getEntry<T>(key);
      if (entry.state === 'negative') {
        opts.onNegativeHit?.(key);
        return null;
      }
      if (entry.state === 'hit') {
        return entry.value;
      }

      // miss OR unavailable → load from source
      const value = await load();
      if (value === null && entry.state === 'miss' && opts.ttl > 0) {
        const ttl = jitteredTtl();
        try {
          await opts.cache.setNegative(key, { ttl });
          opts.onNegativeWrite?.(key);
        } catch {
          // Tombstone write is best-effort — never fail the read path.
        }
      }
      return value;
    },
    async forget(key: string): Promise<void> {
      await opts.cache.delete(key);
    },
  };
}
