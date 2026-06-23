import type { Database } from '@lumibase/database';
import { searchIndexName, type SearchProvider } from '@lumibase/runtime';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { searchRouter } from '../search';

/** DB mock whose `where().limit()` resolves to the supplied collection rows. */
function makeDb(rows: unknown[]): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => fluent } as unknown as Database;
}

function makeSearch(): SearchProvider & {
  search: ReturnType<typeof vi.fn>;
} {
  return {
    index: vi.fn(),
    delete: vi.fn(),
    getIndex: vi.fn(),
    configureIndex: vi.fn(),
    search: vi.fn().mockResolvedValue({
      hits: [{ id: 'i1', _title: 'Hà Nội' }],
      totalHits: 1,
      processingTimeMs: 2,
    }),
  } as never;
}

function buildApp(opts: {
  siteId?: string;
  collectionRows?: unknown[];
  search?: SearchProvider | undefined;
}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', opts.siteId ?? 'site_1');
    c.set('db', makeDb(opts.collectionRows ?? [{ name: 'articles' }]));
    c.set('runtime', { search: opts.search } as never);
    await next();
  });
  app.route('/api/v1/search', searchRouter);
  return app;
}

describe('GET /search', () => {
  it('scopes the search index to the caller site (tenant isolation)', async () => {
    const search = makeSearch();
    const app = buildApp({ siteId: 'site_A', search });

    const res = await app.request('/api/v1/search?q=ha+noi&collection=articles');
    expect(res.status).toBe(200);

    // The physical index queried must be the site-scoped name, never the bare
    // collection — otherwise a tenant could read another tenant's index.
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(search.search.mock.calls[0]?.[0]).toBe(searchIndexName('site_A', 'articles'));
  });

  it('returns 404 when the collection does not belong to the site', async () => {
    const search = makeSearch();
    const app = buildApp({ collectionRows: [], search }); // no matching collection

    const res = await app.request('/api/v1/search?q=x&collection=other_tenant_secrets');
    expect(res.status).toBe(404);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('returns the standard { data, meta } envelope', async () => {
    const app = buildApp({ search: makeSearch() });
    const res = await app.request('/api/v1/search?q=ha+noi&collection=articles');
    const body = (await res.json()) as { data: unknown[]; meta: Record<string, unknown> };
    expect(body.data).toHaveLength(1);
    expect(body.meta).toMatchObject({ collection: 'articles', totalHits: 1, query: 'ha noi' });
  });

  it('400s when q is missing', async () => {
    const app = buildApp({ search: makeSearch() });
    const res = await app.request('/api/v1/search?collection=articles');
    expect(res.status).toBe(400);
  });

  it('fans out across the site collections when collection is omitted', async () => {
    const search = makeSearch();
    const app = buildApp({
      siteId: 'site_A',
      collectionRows: [{ name: 'articles' }, { name: 'pages' }],
      search,
    });

    const res = await app.request('/api/v1/search?q=ha+noi');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: Record<string, unknown> };

    // One scoped search per site collection.
    expect(search.search).toHaveBeenCalledTimes(2);
    const indexNames = search.search.mock.calls.map((c) => c[0]);
    expect(indexNames).toContain(searchIndexName('site_A', 'articles'));
    expect(indexNames).toContain(searchIndexName('site_A', 'pages'));
    // Hits are tagged with their collection.
    expect(body.meta.collections).toEqual(['articles', 'pages']);
    expect((body.data[0] as { _collection?: string })._collection).toBeDefined();
  });

  it('503s when no search provider is configured', async () => {
    const app = buildApp({ search: undefined });
    const res = await app.request('/api/v1/search?q=x&collection=articles');
    expect(res.status).toBe(503);
  });
});
