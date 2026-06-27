import type { Database } from '@lumibase/database';
import { searchIndexName, type SearchProvider } from '@lumibase/runtime';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { searchRouter } from '../search';
import { PermissionService, type CompiledPermission } from '../../services/permission-service';

/** A permissive `read` grant on `articles` with no row-level rule. */
const allowAll = {
  collection: 'articles',
  action: 'read',
  rule: null,
  fields: ['*'],
  presets: {},
  validation: {},
  sources: [{ policyId: 'p', policyName: 'P' }],
} satisfies CompiledPermission;

/** DB mock whose `where().limit()` resolves to the supplied collection rows. */
function makeDb(rows: unknown[]): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => fluent } as unknown as Database;
}

function makeSearch(hits?: Array<Record<string, unknown>>): SearchProvider & {
  search: ReturnType<typeof vi.fn>;
} {
  return {
    index: vi.fn(),
    delete: vi.fn(),
    getIndex: vi.fn(),
    configureIndex: vi.fn(),
    search: vi.fn().mockResolvedValue({
      hits: hits ?? [{ id: 'i1', _title: 'Hà Nội' }],
      totalHits: hits?.length ?? 1,
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
    c.set('auth', { userId: 'user-1', email: 'u@example.test', roles: [], raw: {} } as never);
    c.set('db', makeDb(opts.collectionRows ?? [{ name: 'articles' }]));
    c.set('runtime', { search: opts.search, cache: undefined } as never);
    await next();
  });
  app.route('/api/v1/search', searchRouter);
  return app;
}

describe('GET /search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scopes the search index to the caller site (tenant isolation)', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowAll);
    vi.spyOn(PermissionService.prototype, 'matches').mockReturnValue(true);
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
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowAll);
    const search = makeSearch();
    const app = buildApp({ collectionRows: [], search }); // no matching collection

    const res = await app.request('/api/v1/search?q=x&collection=other_tenant_secrets');
    expect(res.status).toBe(404);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller lacks read permission on the collection', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);
    const search = makeSearch();
    const app = buildApp({ search });

    const res = await app.request('/api/v1/search?q=x&collection=articles');
    expect(res.status).toBe(403);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('masks hit fields the caller may not read and drops rows failing the rule', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue({
      ...allowAll,
      fields: ['title'],
    });
    // First hit passes the row rule, second is filtered out.
    const matches = vi
      .spyOn(PermissionService.prototype, 'matches')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const search = makeSearch([
      { id: 'a', _title: 'Visible', title: 'Visible', secret: 'nope' },
      { id: 'b', _title: 'Hidden', title: 'Hidden', secret: 'nope' },
    ]);
    const app = buildApp({ search });

    const res = await app.request('/api/v1/search?q=x&collection=articles');
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(matches).toHaveBeenCalledTimes(2);
    // Only the first row survives, and `secret` is stripped while `id` + meta + `title` remain.
    expect(body.data).toEqual([{ id: 'a', _title: 'Visible', title: 'Visible' }]);
  });

  it('returns the standard { data, meta } envelope', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowAll);
    vi.spyOn(PermissionService.prototype, 'matches').mockReturnValue(true);
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

  it('400s when collection is omitted (cross-collection unsupported)', async () => {
    const app = buildApp({ search: makeSearch() });
    const res = await app.request('/api/v1/search?q=hello');
    expect(res.status).toBe(400);
  });

  it('503s when no search provider is configured', async () => {
    const app = buildApp({ search: undefined });
    const res = await app.request('/api/v1/search?q=x&collection=articles');
    expect(res.status).toBe(503);
  });
});
