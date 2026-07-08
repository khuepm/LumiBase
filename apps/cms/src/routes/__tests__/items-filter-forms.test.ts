import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { itemsRouter } from '../items';

/**
 * Route-level proof that `GET /items/:collection` accepts BOTH filter forms and
 * hands the SAME parsed object down to ItemService.list. We stub the service's
 * `list` so no DB/runtime is needed — we only assert on the `filter` it receives.
 */

function buildApp() {
  const app = new Hono<AppEnv>();
  // Minimal context the items handler / buildService reads.
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    c.set('siteId', '__default__');
    c.set('auth', { userId: 'usr_1', email: 'a@b.c', roles: [] } as never);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined, keys: undefined } as never);
    await next();
  });
  app.route('/items', itemsRouter);
  return app;
}

// buildService reads `c.env['SITE_ROOM']`, so requests need a (bindings) env object.
const ENV = {} as never;
const reqInit = undefined;

function request(app: ReturnType<typeof buildApp>, path: string) {
  return app.request(path, reqInit, ENV);
}

describe('GET /items/:collection — filter forms (route level)', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureFilter() {
    const seen: { filter?: unknown } = {};
    vi.spyOn(ItemService.prototype, 'list').mockImplementation(async (_collection, params) => {
      seen.filter = (params ?? {}).filter;
      return { data: [], meta: { total: 0, page: 1, pageSize: 50, filter_count: 0 } } as never;
    });
    return seen;
  }

  it('bracket form `filter[status][_eq]=published` reaches the service as a nested object', async () => {
    const seen = captureFilter();
    const res = await request(buildApp(), '/items/posts?filter[status][_eq]=published');
    expect(res.status).toBe(200);
    expect(seen.filter).toEqual({ status: { _eq: 'published' } });
  });

  it('bracket form coerces and supports multiple fields + array operators', async () => {
    const seen = captureFilter();
    const res = await request(buildApp(), '/items/posts?filter[featured][_eq]=true&filter[status][_in]=published,scheduled',
    );
    expect(res.status).toBe(200);
    expect(seen.filter).toEqual({
      featured: { _eq: true },
      status: { _in: ['published', 'scheduled'] },
    });
  });

  it('JSON form still works', async () => {
    const seen = captureFilter();
    const res = await request(buildApp(), `/items/posts?filter=${encodeURIComponent(JSON.stringify({ status: { _eq: 'published' } }))}`,
    );
    expect(res.status).toBe(200);
    expect(seen.filter).toEqual({ status: { _eq: 'published' } });
  });

  it('when both forms are present, JSON wins', async () => {
    const seen = captureFilter();
    const json = encodeURIComponent(JSON.stringify({ status: { _eq: 'draft' } }));
    const res = await request(buildApp(), `/items/posts?filter[status][_eq]=published&filter=${json}`,
    );
    expect(res.status).toBe(200);
    expect(seen.filter).toEqual({ status: { _eq: 'draft' } });
  });

  it('malformed JSON filter returns 400 VALIDATION', async () => {
    captureFilter();
    const res = await request(buildApp(), '/items/posts?filter=%7Bnot-json');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('VALIDATION');
  });

  it('no filter param → service receives undefined filter', async () => {
    const seen = captureFilter();
    const res = await request(buildApp(), '/items/posts?limit=10');
    expect(res.status).toBe(200);
    expect(seen.filter).toBeUndefined();
  });
});
