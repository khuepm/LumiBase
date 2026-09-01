import type { CacheProvider } from '../interfaces/cache';
import type { RateLimiterProvider, RateLimitConsumeResult } from '../interfaces/rate-limiter';
import { MemoryRateLimiter } from '../memory-rate-limiter';

let warnedMemoryFallback = false;

/**
 * Rate limiter backed by {@link CacheProvider.increment}. Falls back to an
 * in-memory limiter (warn once) when increment is unavailable — typical on
 * Cloudflare when the PageviewCounter DO binding is absent.
 */
export class CacheBackedRateLimiter implements RateLimiterProvider {
  private readonly memoryFallback: MemoryRateLimiter;

  constructor(
    private readonly cache: CacheProvider,
    memoryFallback?: MemoryRateLimiter,
  ) {
    this.memoryFallback = memoryFallback ?? new MemoryRateLimiter();
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitConsumeResult> {
    const window = Math.max(1, windowSeconds);
    try {
      const count = await this.cache.increment(key, 1, { ttl: window });
      const resetAt = Math.ceil(Date.now() / 1000) + window;
      const allowed = count <= limit;
      return {
        allowed,
        remaining: Math.max(0, limit - count),
        resetAt,
      };
    } catch {
      if (!warnedMemoryFallback) {
        warnedMemoryFallback = true;
        console.warn(
          '[rate-limiter] Cache increment unavailable — using per-isolate in-memory fallback. ' +
            'Multi-instance budgets are not shared until Redis or a CF counter binding is wired.',
        );
      }
      return this.memoryFallback.consume(key, limit, window);
    }
  }
}
