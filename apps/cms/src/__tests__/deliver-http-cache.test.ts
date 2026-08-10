import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { deliverRouter } from '../routes/deliver';
import type { EdgeCacheProvider } from '@lumibase/runtime';

/**
 * Route-level tests for Delivery API HTTP caching
 * (high-load-cache-readiness Req 1.1–1.7; design §3, §13.4 Properties P1–P3).
 *
 * Uses a fluent fake DB (mirrors cdc-routes.test.ts / config-export.test.ts
 * conventions) so the handler runs without a real Postgres. The fake replays
 * a queue of result sets — one entry per `db.select()` call, in execution
 * order — and counts how many selects the handler issued, which is exactly
 * what Property P2 (304 answered WITHOUT hydrating sections) asserts.
 */

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

function appWith(db: ReturnType<typeof fakeDb>, edgeCache?: EdgeCacheProvider) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    if (edgeCache) {
      c.set('runtime', { edgeCache } as AppEnv['Variables']['runtime']);
    }
    await next();
  });
  app.route('/api/v1/deliver', deliverRouter);
  return app;
}

const PAGE_ROW: Row = {
  id: 'pg_1',
  siteId: 'site-a',
  slug: 'home',
  title: 'Home',
  layoutConfig: {
    sections: [
      { id: 's1', component: 'hero', source: { collection: 'posts', limit: 2 } },
    ],
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
};

const FINGERPRINT_ROW: Row = { maxUpdatedAt: '2026-06-30 10:00:00', visibleCount: 7 };

const COLLECTION_ROW: Row = { id: 'col_1', siteId: 'site-a', name: 'posts' };

const ITEM_ROW: Row = {
  id: 'it_1',
  status: 'published',
  sort: 0,
  data: { title: 'Hello' },
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-02T00:00:00Z'),
};

const URL = '/api/v1/deliver/page/site-a/home';

describe('GET /deliver/page — HTTP caching', () => {
  it('serves 200 with ETag, public Cache-Control and Vary (Req 1.1, 1.2, 1.5)', async () => {
    const db = fakeDb([[PAGE_ROW], [FINGERPRINT_ROW], [COLLECTION_ROW], [ITEM_ROW]]);
    const res = await appWith(db).request(URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
    // Every input `middleware/tenant.ts` resolves the site from, except
    // `?site=` which is already part of the cache key (#390).
    expect(res.headers.get('vary')).toBe('X-Lumi-Site, Host');

    const body = (await res.json()) as { sections: Array<{ data: { items: unknown[] } }> };
    expect(body.sections[0]?.data.items).toHaveLength(1);
    expect(db.selectCount()).toBe(4); // page + fingerprint + collection + items
  });

  it('answers a matching If-None-Match with 304 WITHOUT hydrating sections (Req 1.3; Property P2)', async () => {
    const first = fakeDb([[PAGE_ROW], [FINGERPRINT_ROW], [COLLECTION_ROW], [ITEM_ROW]]);
    const initial = await appWith(first).request(URL);
    const etag = initial.headers.get('etag')!;

    const second = fakeDb([[PAGE_ROW], [FINGERPRINT_ROW]]);
    const res = await appWith(second).request(URL, {
      headers: { 'If-None-Match': etag },
    });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(etag);
    // Only page lookup + fingerprint aggregate ran — no section queries.
    expect(second.selectCount()).toBe(2);
  });

  it('rotates the ETag when site content changes (Req 1.7c; Property P1)', async () => {
    const before = await appWith(
      fakeDb([[PAGE_ROW], [FINGERPRINT_ROW], [COLLECTION_ROW], [ITEM_ROW]]),
    ).request(URL);
    const after = await appWith(
      fakeDb([
        [PAGE_ROW],
        [{ maxUpdatedAt: '2026-07-01 09:00:00', visibleCount: 8 }],
        [COLLECTION_ROW],
        [ITEM_ROW],
      ]),
    ).request(URL);

    expect(before.headers.get('etag')).not.toBe(after.headers.get('etag'));
  });

  it('marks credentialed requests private/no-store with no shared ETag (Req 1.4; Property P3)', async () => {
    const db = fakeDb([[PAGE_ROW], [COLLECTION_ROW], [ITEM_ROW]]);
    const res = await appWith(db).request(URL, {
      headers: { Authorization: 'Bearer token-123' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('etag')).toBeNull();
    // Credentialed path skips the fingerprint aggregate entirely.
    expect(db.selectCount()).toBe(3);
  });

  it('marks 404 responses no-store', async () => {
    const db = fakeDb([[]]);
    const res = await appWith(db).request('/api/v1/deliver/page/site-a/missing');

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  /**
   * #390 — `Vary` must name every header the tenant is resolved from, so a
   * shared cache keys on them instead of relying on each CDN to include
   * `Host` by convention.
   */
  it('declares Host alongside X-Lumi-Site on every publicly cacheable response', async () => {
    const page = fakeDb([[PAGE_ROW], [FINGERPRINT_ROW], [COLLECTION_ROW], [ITEM_ROW]]);
    const pageRes = await appWith(page).request(URL);

    // llms.txt is browser-cacheable (`max-age`, not just `s-maxage`) and
    // previously carried no Vary at all.
    const site = fakeDb([
      [{ id: 'site-a', name: 'Site A', domain: null }],
      [],
      [],
    ]);
    const llmsRes = await appWith(site).request('/api/v1/deliver/llms.txt/site-a');

    expect(pageRes.headers.get('vary')).toBe('X-Lumi-Site, Host');
    expect(llmsRes.status).toBe(200);
    expect(llmsRes.headers.get('cache-control')).toBe('public, max-age=300');
    expect(llmsRes.headers.get('vary')).toBe('X-Lumi-Site, Host');
  });

  it('calls edgeCache.put on a cacheable 200 response (Req 1.6)', async () => {
    const db = fakeDb([[PAGE_ROW], [FINGERPRINT_ROW], [COLLECTION_ROW], [ITEM_ROW]]);
    const put = vi.fn(async (_req: Request, _response: Response) => undefined);
    const match = vi.fn(async (_req: Request) => null);
    const edgeCache: EdgeCacheProvider = { match, put };

    const res = await appWith(db, edgeCache).request(URL);

    expect(res.status).toBe(200);
    expect(match).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    const stored = put.mock.calls[0]?.[1];
    expect(stored).toBeInstanceOf(Response);
    expect((stored as Response).status).toBe(200);
  });
});
