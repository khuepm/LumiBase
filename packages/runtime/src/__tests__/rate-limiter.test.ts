import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../memory-rate-limiter';

/**
 * Req 12.5 / design §13.1 — two limiter instances sharing one store enforce
 * a single budget (Redis integration is not run in CI; see test docstring).
 */
describe('MemoryRateLimiter shared budget', () => {
  it('two instances sharing a store split one limit across both', async () => {
    const store = new Map<string, { count: number; resetAtMs: number }>();
    const limiterA = new MemoryRateLimiter(store);
    const limiterB = new MemoryRateLimiter(store);
    const key = 'rl:test:principal';
    const limit = 5;
    const windowSeconds = 60;

    for (let i = 0; i < 3; i += 1) {
      const result = await limiterA.consume(key, limit, windowSeconds);
      expect(result.allowed).toBe(true);
    }

    for (let i = 0; i < 2; i += 1) {
      const result = await limiterB.consume(key, limit, windowSeconds);
      expect(result.allowed).toBe(true);
    }

    const blocked = await limiterA.consume(key, limit, windowSeconds);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});

/**
 * Redis-backed shared budget is validated manually against docker-compose Redis.
 * CI uses MemoryRateLimiter only — see `packages/runtime/src/__tests__/rate-limiter.test.ts`.
 */
