import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider, MemoryRateLimiter, type RateLimiterProvider } from '@lumibase/runtime';

import { checkAuthFlowRate, type RegistrationRateLimit } from '../registration-guard';

/**
 * #732 — the public auth-flow brake must hold against a *parallel* burst.
 *
 * The cache path (`checkIpRateLimit`) is a `get` then a `set`: a burst whose
 * requests all read before any writes is admitted wholesale. With an atomic
 * limiter on the runtime, `checkAuthFlowRate` admits exactly `maxPerWindow`.
 */

const LIMIT: RegistrationRateLimit = { maxPerWindow: 5, windowSeconds: 60 };

describe('checkAuthFlowRate', () => {
  it('admits exactly maxPerWindow of a parallel burst when an atomic limiter is present', async () => {
    const runtime = { cache: new MemoryCacheProvider(), rateLimiter: new MemoryRateLimiter() };
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => checkAuthFlowRate(runtime, 'reset-rate', 'site-1', '203.0.113.7', LIMIT)),
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    const blocked = verdicts.find((v) => !v.allowed);
    expect(blocked?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys per scope, site and IP', async () => {
    const runtime = { cache: new MemoryCacheProvider(), rateLimiter: new MemoryRateLimiter() };
    for (let i = 0; i < 5; i += 1) await checkAuthFlowRate(runtime, 'verify-rate', 'site-1', '203.0.113.8', LIMIT);
    expect((await checkAuthFlowRate(runtime, 'verify-rate', 'site-1', '203.0.113.8', LIMIT)).allowed).toBe(false);
    expect((await checkAuthFlowRate(runtime, 'reset-rate', 'site-1', '203.0.113.8', LIMIT)).allowed).toBe(true);
    expect((await checkAuthFlowRate(runtime, 'verify-rate', 'site-2', '203.0.113.8', LIMIT)).allowed).toBe(true);
    expect((await checkAuthFlowRate(runtime, 'verify-rate', 'site-1', '203.0.113.9', LIMIT)).allowed).toBe(true);
  });

  it('allows an unkeyable (missing) IP, as the cache path does', async () => {
    const runtime = { cache: new MemoryCacheProvider(), rateLimiter: new MemoryRateLimiter() };
    for (let i = 0; i < 10; i += 1) {
      expect((await checkAuthFlowRate(runtime, 'reg-rate', 'site-1', '  ', LIMIT)).allowed).toBe(true);
    }
  });

  it('fails open when the limiter itself is down', async () => {
    const broken: RateLimiterProvider = {
      consume: async () => {
        throw new Error('redis down');
      },
    };
    const verdict = await checkAuthFlowRate(
      { cache: new MemoryCacheProvider(), rateLimiter: broken },
      'reg-rate',
      'site-1',
      '203.0.113.10',
      LIMIT,
    );
    expect(verdict.allowed).toBe(true);
  });

  it('falls back to the cache counter when the runtime has no limiter', async () => {
    const runtime = { cache: new MemoryCacheProvider() };
    for (let i = 0; i < 5; i += 1) {
      expect((await checkAuthFlowRate(runtime, 'reg-rate', 'site-1', '203.0.113.11', LIMIT)).allowed).toBe(true);
    }
    expect((await checkAuthFlowRate(runtime, 'reg-rate', 'site-1', '203.0.113.11', LIMIT)).allowed).toBe(false);
  });
});
