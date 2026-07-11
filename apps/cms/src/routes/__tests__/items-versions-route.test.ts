import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/**
 * Content-version routes (content-versioning task 4.3): the thin layer over
 * ContentVersionService — payload validation, `{ data }` envelopes and
 * ContentVersionError → HTTP status mapping.
 *
 * **Validates: Requirements 2 (route surface), 4 (compare), 5 (promote)**
 */

const svc = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  compare: vi.fn(),
  promote: vi.fn(),
};

vi.mock('../../services/content-version-service', () => {
  class ContentVersionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status = 400,
    ) {
      super(message);
      this.name = 'ContentVersionError';
    }
  }
  return {
    ContentVersionError,
    ContentVersionService: vi.fn(function () {
      return svc;
    }),
  };
});
vi.mock('../../services/item-service-factory', () => ({
  itemServiceForRequest: vi.fn(() => ({})),
}));

import { itemsRouter } from '../items';
import { ContentVersionError } from '../../services/content-version-service';

const VERSION = { id: 'v1', key: 'draft-a', name: 'Draft A', data: { title: 'x' }, hash: 'h1' };

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    c.set('siteId', 's1');
    c.set('auth', { userId: 'u1' } as never);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);
  return app;
}

function req(path: string, method = 'GET', body?: unknown) {
  return buildApp().request(`/api/v1/items/posts/i1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('version routes envelope + validation', () => {
  it('GET /versions returns { data } from the service', async () => {
    svc.list.mockResolvedValue([{ ...VERSION, mainChanged: false }]);
    const res = await req('/versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { key: string }[] };
    expect(body.data[0]?.key).toBe('draft-a');
    expect(svc.list).toHaveBeenCalledWith('posts', 'i1');
  });

  it('POST /versions validates key + name (400 VALIDATION)', async () => {
    const res = await req('/versions', 'POST', { key: '' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('VALIDATION');
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('POST /versions/:key/promote returns the item + mainDiverged meta', async () => {
    svc.promote.mockResolvedValue({ item: { id: 'i1' }, mainDiverged: true });
    const res = await req('/versions/draft-a/promote', 'POST');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }; meta: { mainDiverged: boolean } };
    expect(body.data.id).toBe('i1');
    expect(body.meta.mainDiverged).toBe(true);
    expect(svc.promote).toHaveBeenCalledWith('posts', 'i1', 'draft-a');
  });
});

describe('ContentVersionError → HTTP mapping', () => {
  it('maps a 409 duplicate-key error', async () => {
    svc.create.mockRejectedValue(new ContentVersionError('VERSION_EXISTS', 'Key already used.', 409));
    const res = await req('/versions', 'POST', { key: 'draft-a', name: 'Draft A' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('VERSION_EXISTS');
  });

  it('maps a 404 missing-version error on compare', async () => {
    svc.compare.mockRejectedValue(new ContentVersionError('NOT_FOUND', 'Version not found.', 404));
    const res = await req('/versions/ghost/compare');
    expect(res.status).toBe(404);
  });
});
