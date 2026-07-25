import { describe, expect, it, vi } from 'vitest';
import { createProcessCache } from '../process-cache';

/**
 * Unit tests for the per-process TTL cache
 * (high-load-cache-readiness Req 4; design §6.3).
 */

describe('createProcessCache', () => {
  it('recomputes at most once within the TTL window', async () => {
    let clock = 1_000;
    const cache = createProcessCache<number>({ ttlMs: 5_000, now: () => clock });
    const load = vi.fn(async () => 42);

    expect(await cache.get(load)).toBe(42);
    expect(await cache.get(load)).toBe(42);
    clock += 4_999;
    expect(await cache.get(load)).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after the TTL expires', async () => {
    let clock = 0;
    const cache = createProcessCache<number>({ ttlMs: 1_000, now: () => clock });
    const load = vi.fn(async () => clock);

    await cache.get(load);
    clock = 1_000; // exactly at expiry boundary → stale
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches permanently when the predicate matches (one-way flip)', async () => {
    let clock = 0;
    const cache = createProcessCache<boolean>({
      ttlMs: 10,
      cachePermanentlyWhen: (v) => v === true,
      now: () => clock,
    });
    const load = vi.fn(async () => true);

    await cache.get(load);
    clock = 1_000_000; // far beyond any TTL
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache permanently when the predicate does not match', async () => {
    let clock = 0;
    const cache = createProcessCache<boolean>({
      ttlMs: 5_000,
      cachePermanentlyWhen: (v) => v === true,
      now: () => clock,
    });
    const load = vi.fn(async () => false);

    await cache.get(load);
    clock = 5_000;
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent misses into a single load', async () => {
    const cache = createProcessCache<number>({ ttlMs: 1_000, now: () => 0 });
    let resolve!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));

    const a = cache.get(load);
    const b = cache.get(load);
    resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('clear() forces the next get to recompute', async () => {
    const cache = createProcessCache<number>({ ttlMs: 100_000, now: () => 0 });
    const load = vi.fn(async () => 1);
    await cache.get(load);
    cache.clear();
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
