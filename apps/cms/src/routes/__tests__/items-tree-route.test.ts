import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/**
 * Tree routes (#749): `?tree=` list params map to the service's TreeQuery,
 * `POST /:collection/:id/move` validates and envelopes, and tree errors keep
 * their status codes.
 */

const svc = {
  list: vi.fn(),
  move: vi.fn(),
  create: vi.fn(),
};

vi.mock('../../services/item-service-factory', () => ({
  itemServiceForRequest: vi.fn(() => svc),
  permissionServiceForRequest: vi.fn(() => ({})),
}));

import { itemsRouter } from '../items';
import { ItemServiceError } from '../../services/item-service';

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', {} as never);
    c.set('siteId', 's1');
    c.set('auth', { userId: 'u1' } as never);
    await next();
  });
  a.route('/api/v1/items', itemsRouter);
  return a;
}

const get = (qs: string) => app().request(`/api/v1/items/folders${qs}`);
const post = (path: string, body: unknown) =>
  app().request(`/api/v1/items/folders${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  svc.list.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
});

describe('tree list params', () => {
  it('maps children / subtree / ancestors', async () => {
    await get('?tree=children&parent=p1');
    expect(svc.list.mock.calls[0]![1].tree).toEqual({ mode: 'children', parent: 'p1' });
    await get('?tree=children&parent=null');
    expect(svc.list.mock.calls[1]![1].tree).toEqual({ mode: 'children', parent: null });
    await get('?tree=subtree');
    expect(svc.list.mock.calls[2]![1].tree).toEqual({ mode: 'subtree', parent: null });
    await get('?tree=ancestors&node=n1');
    expect(svc.list.mock.calls[3]![1].tree).toEqual({ mode: 'ancestors', node: 'n1' });
  });

  it('a plain list carries no tree scope', async () => {
    await get('');
    expect(svc.list.mock.calls[0]![1].tree).toBeUndefined();
  });

  it('rejects malformed tree queries with 400', async () => {
    expect((await get('?tree=ancestors')).status).toBe(400);
    expect((await get('?parent=p1')).status).toBe(400);
    expect((await get('?tree=sideways')).status).toBe(400);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('surfaces a hidden/missing anchor as 404 and a flat collection as 400', async () => {
    svc.list.mockRejectedValueOnce(new ItemServiceError('NOT_FOUND', 'Item "p1" not found.', 404));
    expect((await get('?tree=children&parent=p1')).status).toBe(404);
    svc.list.mockRejectedValueOnce(new ItemServiceError('TREE_NOT_ENABLED', 'flat', 400));
    const res = await get('?tree=children');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ code: 'TREE_NOT_ENABLED', message: 'flat' }] });
  });
});

describe('POST /:collection/:id/move', () => {
  it('moves and returns { data }', async () => {
    svc.move.mockResolvedValue({ id: 'i1', parentId: 'p1', path: '/p1/i1/', sort: 0 });
    const res = await post('/i1/move', { parentId: 'p1', position: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'i1', parentId: 'p1', path: '/p1/i1/', sort: 0 } });
    expect(svc.move).toHaveBeenCalledWith('folders', 'i1', { parentId: 'p1', position: 0 });
  });

  it('accepts parentId null (move to root)', async () => {
    svc.move.mockResolvedValue({ id: 'i1', parentId: null, path: '/i1/', sort: 3 });
    expect((await post('/i1/move', { parentId: null })).status).toBe(200);
  });

  it('validates the body', async () => {
    expect((await post('/i1/move', {})).status).toBe(400);
    expect((await post('/i1/move', { parentId: 'p', position: -1 })).status).toBe(400);
    expect(svc.move).not.toHaveBeenCalled();
  });

  it('maps a cycle to 409', async () => {
    svc.move.mockRejectedValue(new ItemServiceError('TREE_CYCLE', 'cycle', 409));
    const res = await post('/i1/move', { parentId: 'child' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ errors: [{ code: 'TREE_CYCLE', message: 'cycle' }] });
  });
});

describe('create with parentId', () => {
  it('passes parentId through to the service', async () => {
    svc.create.mockResolvedValue({ id: 'c1', parentId: 'p1', path: '/p1/c1/' });
    const res = await post('', { data: { title: 'x' }, parentId: 'p1' });
    expect(res.status).toBe(201);
    expect(svc.create.mock.calls[0]![1]).toMatchObject({ parentId: 'p1' });
  });
});
