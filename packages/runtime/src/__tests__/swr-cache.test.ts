/**
 * Unit tests for createSwrCache (high-load-cache-readiness task 10.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSwrCache } from '../cache-helpers';
import { MemoryCacheProvider } from '../memory-cache';

describe('createSwrCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 50 concurrent gets into one compute', async () => {
    const cache = new MemoryCacheProvider();
    let computeCount = 0;
    const swr = createSwrCache({
      cache,
      softTtl: 30,
      hardTtl: 60,
      compute: async () => {
        computeCount += 1;
        return { n: computeCount };
      },
    });

    const results = await Promise.all(Array.from({ length: 50 }, () => swr.get('k')));
    expect(computeCount).toBe(1);
    expect(results.every((r) => r.n === 1)).toBe(true);
  });

  it('serves stale between soft and hard TTL while refreshing in background', async () => {
    const cache = new MemoryCacheProvider();
    let computeCount = 0;
    const scheduled: Promise<unknown>[] = [];
    const swr = createSwrCache({
      cache,
      softTtl: 10,
      hardTtl: 60,
      schedule: (p) => {
        scheduled.push(p);
      },
      compute: async () => {
        computeCount += 1;
        return computeCount;
      },
    });

    await expect(swr.get('k')).resolves.toBe(1);
    expect(computeCount).toBe(1);

    vi.advanceTimersByTime(15_000);

    await expect(swr.get('k')).resolves.toBe(1);
    expect(scheduled).toHaveLength(1);

    await scheduled[0];
    expect(computeCount).toBe(2);

    await expect(swr.get('k')).resolves.toBe(2);
  });

  it('blocks on recompute after hard TTL expires', async () => {
    const cache = new MemoryCacheProvider();
    let computeCount = 0;
    const swr = createSwrCache({
      cache,
      softTtl: 10,
      hardTtl: 30,
      compute: async () => {
        computeCount += 1;
        return computeCount;
      },
    });

    await expect(swr.get('k')).resolves.toBe(1);

    vi.advanceTimersByTime(31_000);

    await expect(swr.get('k')).resolves.toBe(2);
    expect(computeCount).toBe(2);
  });
});
