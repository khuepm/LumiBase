import type Redis from 'ioredis';
import type { RateLimiterProvider, RateLimitConsumeResult } from '../interfaces/rate-limiter';

/**
 * Redis fixed-window limiter — INCR + EXPIRE NX on first create (same pattern
 * as {@link RedisCacheProvider.increment}).
 */
export class RedisRateLimiter implements RateLimiterProvider {
  constructor(
    private readonly client: Redis,
    private readonly keyPrefix = 'lumi:rl:',
  ) {}

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitConsumeResult> {
    await this.ensureConnected();
    const fullKey = this.fullKey(key);
    const count = await this.client.incr(fullKey);
    if (count === 1) {
      await this.client.expire(fullKey, Math.max(1, windowSeconds), 'NX');
    }

    let ttl = await this.client.ttl(fullKey);
    if (ttl < 0) {
      await this.client.expire(fullKey, Math.max(1, windowSeconds), 'NX');
      ttl = Math.max(1, windowSeconds);
    }

    const resetAt = Math.ceil(Date.now() / 1000) + ttl;
    const allowed = count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  }
}
