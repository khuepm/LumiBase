import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CacheBackedRateLimiter, CloudflareCacheProvider } from '@lumibase/runtime';
import { CounterStore, handleCounterRequest, type CounterSql } from '../counter-store';

/** Adapts Node's SQLite to the `ctx.storage.sql.exec` cursor surface. */
function sqlite(db = new DatabaseSync(':memory:')): CounterSql {
  return {
    exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as T[];
      return { one: () => rows[0] as T, toArray: () => rows };
    },
  };
}

const kv = {
  get: async () => null,
  put: async () => undefined,
  delete: async () => undefined,
};

/** A CF cache provider whose per-site DOs are real `CounterStore`s on SQLite. */
function cloudflareCache(clock: { now: number }) {
  const stores = new Map<string, CounterStore>();
  const storeFor = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new CounterStore(sqlite(), () => clock.now);
      stores.set(name, store);
    }
    return store;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (input: string, init?: RequestInit) => handleCounterRequest(storeFor(String(id)), new Request(input, init)),
    }),
  };
  return { cache: new CloudflareCacheProvider(kv as never, namespace), storeFor };
}

describe('PageviewCounter store expiry', () => {
  it('lets the Cloudflare API rate limiter recover after its window', async () => {
    const clock = { now: 1_000_000 };
    const { cache } = cloudflareCache(clock);
    const limiter = new CacheBackedRateLimiter(cache);
    const key = 'rl:site_1:user:u1';

    expect((await limiter.consume(key, 2, 60)).allowed).toBe(true);
    expect((await limiter.consume(key, 2, 60)).allowed).toBe(true);
    expect((await limiter.consume(key, 2, 60)).allowed).toBe(false);

    // Later hits inside the window do not extend it (EXPIRE NX semantics).
    clock.now += 59_000;
    expect((await limiter.consume(key, 2, 60)).allowed).toBe(false);

    clock.now += 1_000;
    const fresh = await limiter.consume(key, 2, 60);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(1);
  });

  it('prunes expired windowed keys so they do not accumulate in the DO', async () => {
    const clock = { now: 0 };
    const { cache, storeFor } = cloudflareCache(clock);
    for (let minute = 0; minute < 30; minute += 1) {
      clock.now = minute * 60_000;
      await cache.increment(`dq:site_1:run:${minute}`, 1, { ttl: 120 });
    }
    // Only the slots whose 120 s TTL has not passed are still stored.
    expect(storeFor('site_1').counterRows()).toBe(2);
  });

  it('keeps counters without a TTL and drains only the requested prefix', async () => {
    const clock = { now: 0 };
    const store = new CounterStore(sqlite(), () => clock.now);
    store.increment('pv:site_1:2026-01-01:/a', 3);
    store.increment('rl:site_1:user:u1', 1, 60);
    clock.now = 10 * 60_000;
    expect(store.drain('pv')).toEqual({
      counters: [{ key: 'pv:site_1:2026-01-01:/a', value: 3 }],
      uniques: [],
    });
    // The rate-limit row expired and was pruned; the drain did not touch it.
    expect(store.counterRows()).toBe(0);
  });

  it('adds the expiry column to a DO created before counters had one', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);`);
    db.exec(`INSERT INTO counters (key, value) VALUES ('rl:site_1:user:u1', 99);`);
    const clock = { now: 0 };
    const store = new CounterStore(sqlite(db), () => clock.now);

    // The legacy row is still live; its next TTL-carrying increment arms a window.
    expect(store.increment('rl:site_1:user:u1', 1, 60)).toBe(100);
    clock.now = 60_000;
    expect(store.increment('rl:site_1:user:u1', 1, 60)).toBe(1);
  });
});
