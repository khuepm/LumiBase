/**
 * Unit tests for createNegativeCache (packages/runtime)
 * (high-load-cache-readiness task 22.4).
 */

import { describe, expect, it, vi } from 'vitest';
import { createNegativeCache } from '../cache-helpers';
import { MemoryCacheProvider } from '../memory-cache';
import { NEGATIVE_CACHE_ENVELOPE } from '../interfaces/cache';

describe('createNegativeCache', () => {
  it('returns a hit value without calling load', async () => {
    const cache = new MemoryCacheProvider();
    await cache.set('k', JSON.stringify({ n: 1 }), { ttl: 60 });
    const load = vi.fn(async () => ({ n: 99 }));
    const neg = createNegativeCache({ cache, ttl: 30 });
    await expect(neg.resolve('k', load)).resolves.toEqual({ n: 1 });
    expect(load).not.toHaveBeenCalled();
  });

  it('writes a tombstone envelope on confirmed miss', async () => {
    const cache = new MemoryCacheProvider();
    const neg = createNegativeCache({ cache, ttl: 30, random: () => 0.5 });
    const load = vi.fn(async () => null);
    await expect(neg.resolve('missing', load)).resolves.toBeNull();
    const entry = await cache.getEntry('missing');
    expect(entry.state).toBe('negative');
    // Wire value round-trips through get as null (legacy API).
    await expect(cache.get('missing')).resolves.toBeNull();
    // But the raw store holds the envelope.
    const raw = await cache.getEntry<typeof NEGATIVE_CACHE_ENVELOPE>('missing');
    expect(raw.state).toBe('negative');
  });

  it('serves subsequent resolves from the tombstone without load', async () => {
    const cache = new MemoryCacheProvider();
    const neg = createNegativeCache({ cache, ttl: 30 });
    const load = vi.fn(async () => null);
    await neg.resolve('x', load);
    await neg.resolve('x', load);
    expect(load).toHaveBeenCalledOnce();
  });

  it('does not write a tombstone when backend is unavailable', async () => {
    const cache = new MemoryCacheProvider();
    vi.spyOn(cache, 'getEntry').mockResolvedValue({ state: 'unavailable' });
    const setNegative = vi.spyOn(cache, 'setNegative');
    const load = vi.fn(async () => null);
    const neg = createNegativeCache({ cache, ttl: 30 });
    await neg.resolve('x', load);
    expect(load).toHaveBeenCalledOnce();
    expect(setNegative).not.toHaveBeenCalled();
  });

  it('forget removes the tombstone so the next resolve loads again', async () => {
    const cache = new MemoryCacheProvider();
    const neg = createNegativeCache({ cache, ttl: 30 });
    await neg.resolve('x', async () => null);
    await neg.forget('x');
    const load = vi.fn(async () => ({ ok: true }));
    await expect(neg.resolve('x', load)).resolves.toEqual({ ok: true });
    expect(load).toHaveBeenCalledOnce();
  });

  it('keeps jittered TTL inside [0.8, 1.2] × base', () => {
    const cache = new MemoryCacheProvider();
    const samples = [0, 0.25, 0.5, 0.75, 1];
    let i = 0;
    const neg = createNegativeCache({
      cache,
      ttl: 50,
      jitterRatio: 0.2,
      random: () => samples[i++ % samples.length]!,
    });
    for (let n = 0; n < samples.length; n += 1) {
      const ttl = neg.jitteredTtl();
      expect(ttl).toBeGreaterThanOrEqual(40);
      expect(ttl).toBeLessThanOrEqual(60);
    }
  });
});
