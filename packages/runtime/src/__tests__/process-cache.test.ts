import { describe, expect, it, vi } from 'vitest';
import { withProcessCache, type ProcessCacheStore, type SwrCache } from '../cache-helpers';

/** Inner cache that counts how often the network layer below is consulted. */
function countingInner(): SwrCache<string> & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async get(key: string) {
      calls += 1;
      return `value:${key}:${calls}`;
    },
  };
}

/**
 * #391 — an in-process layer in front of the shared cache. Every hit below it
 * costs a network round-trip; this one costs a map lookup. It is only sound
 * for keys that carry a version segment, so a stale entry becomes
 * unaddressable rather than wrong.
 */
describe('withProcessCache', () => {
  const key = 'perm:site-a:v1:user-1';

  it('serves a repeat read without touching the layer below', async () => {
    const inner = countingInner();
    const cache = withProcessCache(inner, { maxEntries: 10, ttlMs: 5_000 });

    const first = await cache.get(key);
    const second = await cache.get(key);

    expect(second).toBe(first);
    expect(inner.calls()).toBe(1);
  });

  it('recomputes once the TTL has passed', async () => {
    const inner = countingInner();
    let clock = 1_000;
    const cache = withProcessCache(inner, {
      maxEntries: 10,
      ttlMs: 5_000,
      now: () => clock,
    });

    await cache.get(key);
    clock += 4_999;
    await cache.get(key);
    expect(inner.calls()).toBe(1);

    clock += 2;
    await cache.get(key);
    expect(inner.calls()).toBe(2);
  });

  /**
   * The failure this guards against is subtle: a per-request service that
   * builds its own store never returns a hit, so the cache looks wired and
   * does nothing. Sharing a module-level store is what makes it a *process*
   * cache.
   */
  it('shares entries across wrappers when given a shared store', async () => {
    const store: ProcessCacheStore<string> = new Map();
    const innerA = countingInner();
    const innerB = countingInner();

    await withProcessCache(innerA, { store, maxEntries: 10, ttlMs: 5_000 }).get(key);
    await withProcessCache(innerB, { store, maxEntries: 10, ttlMs: 5_000 }).get(key);

    // The second wrapper — a different request's service — hit the store.
    expect(innerA.calls()).toBe(1);
    expect(innerB.calls()).toBe(0);
  });

  it('does not share entries when each wrapper owns its store', async () => {
    const innerA = countingInner();
    const innerB = countingInner();

    await withProcessCache(innerA, { maxEntries: 10, ttlMs: 5_000 }).get(key);
    await withProcessCache(innerB, { maxEntries: 10, ttlMs: 5_000 }).get(key);

    expect(innerB.calls()).toBe(1);
  });

  it('never serves one tenant a value cached for another', async () => {
    const store: ProcessCacheStore<string> = new Map();
    const inner = countingInner();
    const cache = withProcessCache(inner, { store, maxEntries: 10, ttlMs: 5_000 });

    const a = await cache.get('perm:site-a:v1:user-1');
    const b = await cache.get('perm:site-b:v1:user-1');

    expect(a).not.toBe(b);
    expect(inner.calls()).toBe(2);
  });

  it('treats a bumped version as a different key, so revocation is not delayed', async () => {
    const store: ProcessCacheStore<string> = new Map();
    const inner = countingInner();
    const cache = withProcessCache(inner, { store, maxEntries: 10, ttlMs: 60_000 });

    const before = await cache.get('perm:site-a:v1:user-1');
    // A permission change bumps the pointer; the next read addresses v2 and
    // cannot reach the v1 entry, even though its TTL has not expired.
    const after = await cache.get('perm:site-a:v2:user-1');

    expect(after).not.toBe(before);
    expect(inner.calls()).toBe(2);
  });

  it('evicts the oldest entry at the cap instead of growing without bound', async () => {
    const inner = countingInner();
    const cache = withProcessCache(inner, { maxEntries: 2, ttlMs: 60_000 });

    await cache.get('k1');
    await cache.get('k2');
    await cache.get('k3'); // evicts k1
    expect(inner.calls()).toBe(3);

    await cache.get('k1'); // gone — recomputed
    expect(inner.calls()).toBe(4);
    await cache.get('k3'); // still held
    expect(inner.calls()).toBe(4);
  });

  it('does not let an expired entry hold a slot against a live one', async () => {
    const store: ProcessCacheStore<string> = new Map();
    let clock = 0;
    const inner = countingInner();
    const cache = withProcessCache(inner, {
      store,
      maxEntries: 1,
      ttlMs: 1_000,
      now: () => clock,
    });

    await cache.get('k1');
    clock += 2_000;
    await cache.get('k1');

    expect(store.size).toBe(1);
  });

  it('reports hit and miss so the layer can be measured, not assumed', async () => {
    const onLookup = vi.fn();
    const cache = withProcessCache(countingInner(), {
      maxEntries: 10,
      ttlMs: 5_000,
      onLookup,
    });

    await cache.get(key);
    await cache.get(key);

    expect(onLookup).toHaveBeenNthCalledWith(1, 'miss');
    expect(onLookup).toHaveBeenNthCalledWith(2, 'hit');
  });
});
