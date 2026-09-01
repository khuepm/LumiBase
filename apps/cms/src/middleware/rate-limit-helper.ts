import type { RateLimiterProvider } from '@lumibase/runtime';

export interface RateLimitMiddlewareResult {
  readonly status: 'allow' | 'block' | 'unavailable';
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

/**
 * Consume one unit from a {@link RateLimiterProvider}. Returns a structured
 * result for middleware to map to HTTP headers / status codes.
 */
export async function consumeRateLimit(
  rateLimiter: RateLimiterProvider | undefined,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitMiddlewareResult> {
  if (limit <= 0) {
    return {
      status: 'allow',
      limit,
      remaining: limit,
      resetAt: Math.ceil(Date.now() / 1000) + windowSeconds,
      retryAfterSeconds: 0,
    };
  }

  if (!rateLimiter) {
    return {
      status: 'unavailable',
      limit,
      remaining: 0,
      resetAt: Math.ceil(Date.now() / 1000) + windowSeconds,
      retryAfterSeconds: windowSeconds,
    };
  }

  try {
    const result = await rateLimiter.consume(key, limit, windowSeconds);
    const retryAfterSeconds = result.allowed
      ? 0
      : Math.max(1, result.resetAt - Math.ceil(Date.now() / 1000));
    return {
      status: result.allowed ? 'allow' : 'block',
      limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfterSeconds,
    };
  } catch {
    return {
      status: 'unavailable',
      limit,
      remaining: 0,
      resetAt: Math.ceil(Date.now() / 1000) + windowSeconds,
      retryAfterSeconds: windowSeconds,
    };
  }
}
