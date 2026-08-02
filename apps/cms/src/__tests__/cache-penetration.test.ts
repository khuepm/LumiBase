/**
 * Identifier-guard + deliver penetration tests
 * (high-load-cache-readiness Req 19; design §13.4 P17–P20).
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { deliverRouter } from '../routes/deliver';
import { withTenant } from '../middleware/tenant';
import {
  isValidCollectionName,
  isValidSiteId,
  isValidSlug,
} from '../services/identifier-guard';
import {
  buildNegativeCache,
  forgetNegative,
  negativeCollectionKey,
  negativePageKey,
  NEGATIVE_KEY_MAXLEN,
} from '../services/negative-cache';
import { createNegativeCache } from '@lumibase/runtime';

type Row = Record<string, unknown>;

function fakeDb(queue: Row[][]) {
  let selects = 0;
  const db = {
    select: () => {
      const result = Promise.resolve(queue[selects] ?? []);
      selects += 1;
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => builder,
        orderBy: () => builder,
        innerJoin: () => builder,
        then: (
          onFulfilled?: (value: Row[]) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => result.then(onFulfilled, onRejected),
      };
      return builder;
    },
    selectCount: () => selects,
  };
  return db;
}

function deliverApp(opts: {
  db: ReturnType<typeof fakeDb>;
  cache?: MemoryCacheProvider;
  env?: Record<string, string>;
}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', opts.db as never);
    if (opts.cache) c.set('runtime', { cache: opts.cache } as never);
    await next();
  });
  app.route('/api/v1/deliver', deliverRouter);

  const request = (path: string, init?: RequestInit) =>
    app.request(path, init, opts.env ?? {});

  return { request };
}

const PAGE_ROW: Row = {
  id: 'pg_1',
  siteId: 'site-a',
  slug: 'home',
  title: 'Home',
  layoutConfig: { sections: [] },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
};

describe('identifier-guard (task 22.1)', () => {
  it('accepts surveyed site-id shapes including __default__ and short labels', () => {
    for (const id of ['__default__', 'site-a', 'site_test', 'V1StGXR8_Z5jdHi6B-myT', 's1']) {
      expect(isValidSiteId(id)).toBe(true);
    }
  });

  it('rejects site ids with injection / traversal characters', () => {
    for (const id of ['../etc', 'a b', 'site@x', '', 'x'.repeat(65), "a';drop"]) {
      expect(isValidSiteId(id)).toBe(false);
    }
  });

  it('accepts surveyed slugs and rejects uppercase / oversize', () => {
    expect(isValidSlug('home')).toBe(true);
    expect(isValidSlug('seo-toolkit')).toBe(true);
    expect(isValidSlug('features/ai-copilot')).toBe(true);
    expect(isValidSlug('Home')).toBe(false);
    expect(isValidSlug('a'.repeat(201))).toBe(false);
    expect(isValidSlug('-leading')).toBe(false);
  });

  it('keeps SAFE_FIELD_NAME / collection shape', () => {
    expect(isValidCollectionName('posts')).toBe(true);
    expect(isValidCollectionName('_meta')).toBe(true);
    expect(isValidCollectionName('1bad')).toBe(false);
    expect(isValidCollectionName('has-dash')).toBe(false);
  });
});

describe('P17 — bad-shape identifiers → 404 with 0 DB queries', () => {
  it('rejects a malformed site_id without touching the DB', async () => {
    const db = fakeDb([[PAGE_ROW]]);
    const res = await deliverApp({ db }).request('/api/v1/deliver/page/site@evil/home');
    expect(res.status).toBe(404);
    expect(db.selectCount()).toBe(0);
  });

  it('rejects a malformed slug without touching the DB', async () => {
    const db = fakeDb([[PAGE_ROW]]);
    const res = await deliverApp({ db }).request('/api/v1/deliver/page/site-a/Has%20Spaces');
    expect(res.status).toBe(404);
    expect(db.selectCount()).toBe(0);
  });

  it('rejects a malformed llms.txt site_id without touching the DB', async () => {
    const db = fakeDb([[{ id: 'x' }]]);
    const res = await deliverApp({ db }).request('/api/v1/deliver/llms.txt/not valid!');
    expect(res.status).toBe(404);
    expect(db.selectCount()).toBe(0);
  });
});

describe('404 must not be an oracle (design §14.6, dod-review §2c)', () => {
  it('returns a byte-identical 404 for bad shape and for a real miss', async () => {
    // Bad shape → rejected by the guard, zero DB queries.
    const badShape = fakeDb([]);
    const shapeRes = await deliverApp({ db: badShape }).request(
      '/api/v1/deliver/page/site-a/Has%20Spaces',
    );

    // Well-formed but absent → guard passes, DB queried, still 404.
    const realMiss = fakeDb([[]]);
    const missRes = await deliverApp({ db: realMiss }).request(
      '/api/v1/deliver/page/site-a/no-such-page',
    );

    expect(shapeRes.status).toBe(404);
    expect(missRes.status).toBe(404);
    expect(badShape.selectCount()).toBe(0);
    expect(realMiss.selectCount()).toBeGreaterThan(0);

    // The whole point: a prober cannot tell the two apart. If these ever
    // diverge, the endpoint leaks which identifiers are well-formed.
    expect(await shapeRes.text()).toBe(await missRes.text());
    expect(shapeRes.headers.get('cache-control')).toBe(
      missRes.headers.get('cache-control'),
    );
  });
});

describe('negative key material is bounded (design §14.5)', () => {
  it('clamps an oversized collection name instead of minting a giant key', () => {
    // SAFE_FIELD_NAME bounds the alphabet but not the length, so an
    // authenticated caller could otherwise mint multi-KB Redis keys.
    const huge = 'a'.repeat(10_000);
    const key = negativeCollectionKey('site-a', huge);
    expect(key.length).toBeLessThanOrEqual(`neg:site-a:collection:`.length + NEGATIVE_KEY_MAXLEN);
    expect(key.startsWith('neg:site-a:collection:aaa')).toBe(true);
  });

  it('leaves a normal collection name untouched', () => {
    expect(negativeCollectionKey('site-a', 'posts')).toBe('neg:site-a:collection:posts');
  });
});

describe('tenant middleware — X-Lumi-Site shape (Req 19.2)', () => {
  it('returns 400 TENANT_INVALID for a malformed header', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withTenant());
    app.get('/x', (c) => c.json({ siteId: c.get('siteId') }));
    const res = await app.request('/x', { headers: { 'X-Lumi-Site': '../nope' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('TENANT_INVALID');
  });

  it('accepts a well-formed header', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withTenant());
    app.get('/x', (c) => c.json({ siteId: c.get('siteId') }));
    const res = await app.request('/x', { headers: { 'X-Lumi-Site': '__default__' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: '__default__' });
  });
});

describe('P18 — repeated missing slug → one DB query then tombstone', () => {
  it('writes a tombstone on first miss and serves subsequent 404s from cache', async () => {
    const cache = new MemoryCacheProvider();
    const db = fakeDb([[], [], []]); // all page lookups empty
    const app = deliverApp({
      db,
      cache,
      env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' },
    });

    const first = await app.request('/api/v1/deliver/page/site-a/missing');
    expect(first.status).toBe(404);
    expect(db.selectCount()).toBe(1);

    const second = await app.request('/api/v1/deliver/page/site-a/missing');
    const third = await app.request('/api/v1/deliver/page/site-a/missing');
    expect(second.status).toBe(404);
    expect(third.status).toBe(404);
    // Still exactly one select — N−1 served from tombstone.
    expect(db.selectCount()).toBe(1);

    const entry = await cache.getEntry(negativePageKey('site-a', 'missing'));
    expect(entry.state).toBe('negative');
  });
});

describe('P19 — forget tombstone after create → immediate 200', () => {
  it('serves the page after forget without waiting for TTL', async () => {
    const cache = new MemoryCacheProvider();
    // First request: miss → tombstone. Second: after forget + page exists.
    const db1 = fakeDb([[]]);
    const app1 = deliverApp({ db: db1, cache, env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' } });
    await app1.request('/api/v1/deliver/page/site-a/home');
    expect((await cache.getEntry(negativePageKey('site-a', 'home'))).state).toBe('negative');

    await forgetNegative(cache, negativePageKey('site-a', 'home'));

    const db2 = fakeDb([
      [PAGE_ROW],
      [{ maxUpdatedAt: '2026-06-30', visibleCount: 1 }],
    ]);
    const app2 = deliverApp({ db: db2, cache, env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' } });
    const res = await app2.request('/api/v1/deliver/page/site-a/home');
    expect(res.status).toBe(200);
  });
});

describe('P20 — tombstone isolation + credentials never receive tombstone', () => {
  it('keeps site-a tombstone from affecting site-b', async () => {
    const cache = new MemoryCacheProvider();
    const dbA = fakeDb([[]]);
    await deliverApp({ db: dbA, cache, env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' } }).request(
      '/api/v1/deliver/page/site-a/shared-slug',
    );
    expect((await cache.getEntry(negativePageKey('site-a', 'shared-slug'))).state).toBe('negative');
    expect((await cache.getEntry(negativePageKey('site-b', 'shared-slug'))).state).toBe('miss');

    const pageB = { ...PAGE_ROW, siteId: 'site-b', slug: 'shared-slug' };
    const dbB = fakeDb([
      [pageB],
      [{ maxUpdatedAt: null, visibleCount: 0 }],
    ]);
    const res = await deliverApp({
      db: dbB,
      cache,
      env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' },
    }).request('/api/v1/deliver/page/site-b/shared-slug');
    expect(res.status).toBe(200);
  });

  it('bypasses tombstone for credentialed requests (still queries DB)', async () => {
    const cache = new MemoryCacheProvider();
    // Seed a tombstone as if a prior anonymous miss wrote it.
    await cache.setNegative(negativePageKey('site-a', 'secret'), { ttl: 30 });

    const db = fakeDb([[PAGE_ROW], [{ maxUpdatedAt: null, visibleCount: 0 }]]);
    // PAGE_ROW has slug home — use matching URL; tombstone key differs so
    // we seed the same key the handler would look up.
    await cache.setNegative(negativePageKey('site-a', 'home'), { ttl: 30 });

    const res = await deliverApp({
      db,
      cache,
      env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' },
    }).request('/api/v1/deliver/page/site-a/home', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    // Credentialed path still hit the DB despite the tombstone.
    expect(db.selectCount()).toBeGreaterThan(0);
  });
});

describe('Req 19.14 — DB-query-per-404 ≤ 0.05 (finite miss pool)', () => {
  it('absorbs ≥95% of repeated missing-slug 404s via tombstones', async () => {
    const cache = new MemoryCacheProvider();
    const db = fakeDb(Array.from({ length: 200 }, () => []));
    const app = deliverApp({
      db,
      cache,
      env: { LUMIBASE_NEGATIVE_CACHE_TTL: '30' },
    });

    const missPool = 40;
    const rounds = 25; // 40 × 25 = 1000 miss-pool hits after warm-up
    let notFound = 0;

    // Warm the pool once (one DB query per key).
    for (let i = 0; i < missPool; i++) {
      const res = await app.request(`/api/v1/deliver/page/site-a/miss-${i}`);
      expect(res.status).toBe(404);
      notFound += 1;
    }
    const warmQueries = db.selectCount();
    expect(warmQueries).toBe(missPool);

    // Repeat the same keys — must be served from tombstones (0 extra selects).
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < missPool; i++) {
        const res = await app.request(`/api/v1/deliver/page/site-a/miss-${i}`);
        expect(res.status).toBe(404);
        notFound += 1;
      }
    }

    expect(db.selectCount()).toBe(warmQueries);
    const queriesPer404 = db.selectCount() / notFound;
    expect(queriesPer404).toBeLessThanOrEqual(0.05);
  });
});

describe('createNegativeCache helper (task 22.4)', () => {
  it('applies jitter within ±20% of the base TTL', () => {
    const cache = new MemoryCacheProvider();
    const values: number[] = [];
    let i = 0;
    const sequence = [0, 0.5, 1];
    const neg = createNegativeCache({
      cache,
      ttl: 100,
      jitterRatio: 0.2,
      random: () => sequence[i++ % sequence.length]!,
    });
    values.push(neg.jitteredTtl(), neg.jitteredTtl(), neg.jitteredTtl());
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(80);
      expect(v).toBeLessThanOrEqual(120);
    }
  });

  it('calls load on unavailable instead of treating it as a miss', async () => {
    const cache = new MemoryCacheProvider();
    vi.spyOn(cache, 'getEntry').mockResolvedValue({ state: 'unavailable' });
    const setNegative = vi.spyOn(cache, 'setNegative');
    const load = vi.fn(async () => null);
    const neg = buildNegativeCache(cache, 30);
    await neg.resolve('k', load);
    expect(load).toHaveBeenCalledOnce();
    expect(setNegative).not.toHaveBeenCalled();
  });
});
