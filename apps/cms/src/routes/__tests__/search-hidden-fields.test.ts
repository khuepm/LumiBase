import type { Database } from '@lumibase/database';
import type { SearchProvider } from '@lumibase/runtime';
import { Hono } from 'hono';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { maskSearchHit, searchRouter, unreadableSearchAttribute } from '../search';
import { PermissionService, type CompiledPermission } from '../../services/permission-service';
import { buildSearchDocument } from '../../services/search-document';

/**
 * Search must not be an oracle on fields the caller cannot read (#738):
 * `_title` is copied from an item field and is what `q` matches, the engine's
 * `totalHits` counts rows the caller cannot see, and `filter` / `sort` are raw
 * engine expressions.
 */

function perm(fields: string[], rule: CompiledPermission['rule'] = null): CompiledPermission {
  return {
    collection: 'articles',
    action: 'read',
    rule,
    fields,
    presets: {},
    validation: {},
    sources: [{ policyId: 'p', policyName: 'P' }],
  };
}

function makeDb(rows: unknown[]): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => fluent } as unknown as Database;
}

function makeSearch(hits: Array<Record<string, unknown>>, totalHits = hits.length) {
  return {
    index: vi.fn(),
    delete: vi.fn(),
    getIndex: vi.fn(),
    configureIndex: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits, totalHits, processingTimeMs: 1 }),
  } as unknown as SearchProvider & { search: ReturnType<typeof vi.fn> };
}

function buildApp(search: SearchProvider, collectionRows: unknown[] = [{ name: 'articles' }]) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site_1');
    c.set('auth', { userId: 'user-1', email: 'u@example.test', roles: [], raw: {} } as never);
    c.set('db', makeDb(collectionRows));
    c.set('runtime', { search, cache: undefined } as never);
    await next();
  });
  app.route('/api/v1/search', searchRouter);
  return app;
}

describe('search — hidden fields (#738)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops a hit whose _title was derived from a hidden field, and reports the visible count', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(perm(['*', '-title']));
    vi.spyOn(PermissionService.prototype, 'matches').mockReturnValue(true);
    const hits = [
      buildSearchDocument('articles', 'a', { title: 'Confidential merger', summary: 'Public text' }),
      buildSearchDocument('articles', 'b', { summary: 'Only public' }),
    ];
    const res = await buildApp(makeSearch(hits, 57)).request('/api/v1/search?q=merger&collection=articles');
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.data.map((h) => h.id)).toEqual(['b']);
    expect(JSON.stringify(body)).not.toContain('Confidential');
    // The engine total (57) counted rows the caller cannot see.
    expect(body.meta.totalHits).toBe(1);
  });

  it('keeps readable fields under a `*` + exclusion whitelist (was over-masked)', () => {
    const hit = buildSearchDocument('articles', 'a', { title: 'T', body: 'B', secret: 'S' });
    expect(maskSearchHit(hit, perm(['*', '-secret']))).toEqual({
      id: 'a',
      _collection: 'articles',
      _title: 'T',
      title: 'T',
      body: 'B',
    });
  });

  it('a row rule alone also hides the engine total', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(perm(['*'], { owner: { _eq: '$CURRENT_USER' } }));
    vi.spyOn(PermissionService.prototype, 'matches').mockReturnValueOnce(true).mockReturnValue(false);
    const hits = [buildSearchDocument('articles', 'a', { title: 'x' }), buildSearchDocument('articles', 'b', { title: 'y' })];
    const res = await buildApp(makeSearch(hits, 40)).request('/api/v1/search?q=x&collection=articles');
    const body = (await res.json()) as { meta: Record<string, unknown> };
    expect(body.meta.totalHits).toBe(1);
  });

  it.each([
    ['filter', 'secret = "x"'],
    ['filter', '_title = "x"'],
    ['filter', 'title = "a" OR (secret EXISTS)'],
    ['sort', 'secret:asc'],
    ['sort', '_title:desc'],
  ])('refuses %s %s on a hidden attribute with 403 before searching', async (param, value) => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(perm(['title']));
    const search = makeSearch([]);
    const res = await buildApp(search).request(
      `/api/v1/search?q=x&collection=articles&${param}=${encodeURIComponent(value)}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('FIELD_FORBIDDEN');
    expect(search.search).not.toHaveBeenCalled();
  });

  it('allows readable / meta attributes with quoted values', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(perm(['title']));
    vi.spyOn(PermissionService.prototype, 'matches').mockReturnValue(true);
    const search = makeSearch([]);
    const res = await buildApp(search).request(
      `/api/v1/search?q=x&collection=articles&filter=${encodeURIComponent('_collection = "articles" AND title = "a b"')}&sort=_updatedAt:desc`,
    );
    expect(res.status).toBe(200);
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it('cross-collection search skips a collection whose filter names a hidden field', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection?: string) =>
      collection === 'articles' ? perm(['title']) : perm(['*']),
    );
    vi.spyOn(PermissionService.prototype, 'matches').mockReturnValue(true);
    const search = makeSearch([]);
    const res = await buildApp(search, [{ name: 'articles' }, { name: 'pages' }]).request(
      `/api/v1/search?q=x&filter=${encodeURIComponent('secret = "x"')}`,
    );
    const body = (await res.json()) as { meta: Record<string, unknown> };
    expect(body.meta.collections).toEqual(['pages']);
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it('property: a returned hit never carries a hidden value, and the decision ignores hidden data', () => {
    const value = fc.string({ minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(value, value, value, fc.constantFrom('title', 'name', 'summary'), (pub, hiddenA, hiddenB, hiddenKey) => {
        const permission = perm(['*', `-${hiddenKey}`]);
        const mk = (hidden: string) =>
          buildSearchDocument('articles', 'id1', { [hiddenKey]: `H:${hidden}`, other: `P:${pub}` });
        const a = maskSearchHit(mk(hiddenA), permission);
        const b = maskSearchHit(mk(hiddenB), permission);
        // Same verdict whatever the hidden value is.
        expect(a === null).toBe(b === null);
        for (const out of [a, b]) {
          if (out) expect(JSON.stringify(out)).not.toContain('H:');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: filter attributes outside the whitelist are always refused', () => {
    const word = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
    fc.assert(
      fc.property(word, fc.string({ maxLength: 8 }), (attr, raw) => {
        const filter = `${attr} = ${JSON.stringify(raw)}`;
        const keywords = ['and', 'or', 'not', 'in', 'to', 'exists', 'is', 'null', 'empty', 'contains', 'starts', 'with'];
        if (keywords.includes(attr)) return;
        const verdict = unreadableSearchAttribute(perm(['title']), filter, undefined);
        expect(verdict === null).toBe(attr === 'title');
      }),
      { numRuns: 300 },
    );
  });
});
