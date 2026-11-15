import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/**
 * Item routes: `ETag` on detail and successful writes, `If-Match` passed to
 * the service as `expectedVersions`, 412 mapped from the service error.
 *
 * **Validates: content-environments Req 6.1-6.3**
 */

const svc = {
  detail: vi.fn(),
  patch: vi.fn(),
  replace: vi.fn(),
};

vi.mock('../../services/item-service-factory', () => ({
  itemServiceForRequest: vi.fn(() => svc),
  permissionServiceForRequest: vi.fn(() => ({})),
}));

import { itemsRouter } from '../items';
import { ItemServiceError } from '../../services/item-service';

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

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...headers },
});

describe('items routes — ETag / If-Match', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET detail sends the version as a strong ETag', async () => {
    svc.detail.mockImplementation(async (_c, _id, _f, _d, meta: { version?: number }) => {
      meta.version = 4;
      return { id: 'a', data: { title: 'x' } };
    });
    const res = await buildApp().request('/api/v1/items/posts/a?fields=title');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"4"');
  });

  it('PATCH without If-Match passes no precondition', async () => {
    svc.patch.mockResolvedValue({ id: 'a', version: 5 });
    const res = await buildApp().request('/api/v1/items/posts/a', { method: 'PATCH', ...json({ data: { title: 'y' } }) });
    expect(res.status).toBe(200);
    expect(svc.patch).toHaveBeenCalledWith('posts', 'a', { data: { title: 'y' } }, { expectedVersions: undefined });
    expect(res.headers.get('etag')).toBe('"5"');
  });

  it('PATCH and PUT forward If-Match as expected versions', async () => {
    svc.patch.mockResolvedValue({ id: 'a', version: 5 });
    svc.replace.mockResolvedValue({ id: 'a', version: 6 });
    const app = buildApp();
    await app.request('/api/v1/items/posts/a', { method: 'PATCH', ...json({ data: { title: 'y' } }, { 'if-match': '"4"' }) });
    await app.request('/api/v1/items/posts/a', { method: 'PUT', ...json({ data: { title: 'z' } }, { 'if-match': 'W/"5"' }) });
    expect(svc.patch.mock.calls[0]![3]).toEqual({ expectedVersions: [4] });
    // A weak tag can never match: an empty list, which the service rejects.
    expect(svc.replace.mock.calls[0]![3]).toEqual({ expectedVersions: [] });
  });

  it('`*` is no precondition', async () => {
    svc.patch.mockResolvedValue({ id: 'a', version: 5 });
    await buildApp().request('/api/v1/items/posts/a', { method: 'PATCH', ...json({ data: {} }, { 'if-match': '*' }) });
    expect(svc.patch.mock.calls[0]![3]).toEqual({ expectedVersions: undefined });
  });

  it('maps PRECONDITION_FAILED to 412 without an ETag', async () => {
    svc.patch.mockRejectedValue(new ItemServiceError('PRECONDITION_FAILED', 'changed', 412));
    const res = await buildApp().request('/api/v1/items/posts/a', {
      method: 'PATCH',
      ...json({ data: { title: 'y' } }, { 'if-match': '"1"' }),
    });
    expect(res.status).toBe(412);
    expect(res.headers.get('etag')).toBeNull();
    expect(await res.json()).toEqual({ errors: [{ code: 'PRECONDITION_FAILED', message: 'changed' }] });
  });
});
