import type { RateLimiterProvider, RateLimitConsumeResult } from './interfaces/rate-limiter';

interface WindowBucket {
  count: number;
  resetAtMs: number;
}

/**
 * In-process fixed-window rate limiter. Pass a shared `store` Map so multiple
 * instances enforce one budget (tests / per-isolate CF fallback).
 */
export class MemoryRateLimiter implements RateLimiterProvider {
  private readonly store: Map<string, WindowBucket>;
  private readonly nowFn: () => number;

  constructor(
    store?: Map<string, WindowBucket>,
    nowFn: () => number = () => Date.now(),
  ) {
    this.store = store ?? new Map();
    this.nowFn = nowFn;
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitConsumeResult> {
    const now = this.nowFn();
    const windowMs = Math.max(1, windowSeconds) * 1000;
    let bucket = this.store.get(key);

    if (!bucket || bucket.resetAtMs <= now) {
      bucket = { count: 1, resetAtMs: now + windowMs };
      this.store.set(key, bucket);
      return {
        allowed: true,
        remaining: Math.max(0, limit - 1),
        resetAt: Math.ceil(bucket.resetAtMs / 1000),
      };
    }

    bucket.count += 1;
    const allowed = bucket.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: Math.ceil(bucket.resetAtMs / 1000),
    };
  }

  /** Test helper — clear all windows. */
  clear(): void {
    this.store.clear();
  }
}
