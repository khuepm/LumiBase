import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaRouter } from '../media';
import { PermissionService, type CompiledPermission } from '../../services/permission-service';
import type { AppEnv } from '../../env';

const allowPermission = {
  collection: 'media',
  action: 'read',
  rule: null,
  fields: ['*'],
  presets: {},
  validation: {},
  sources: [{ policyId: 'policy-media', policyName: 'Media' }],
} satisfies CompiledPermission;

describe('mediaRouter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires explicit media permissions before reading storage', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);
    const storage = mockStorage();

    const res = await appFor(storage).request('/media/asset.txt');

    expect(res.status).toBe(403);
    expect(PermissionService.prototype.canAccess).toHaveBeenCalledWith('media', 'read');
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('lists only the authenticated site namespace and returns public keys', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);
    const storage = mockStorage({
      list: vi.fn(async () => ({ keys: ['sites/site-a/media/folder/a.txt'] })),
    });

    const res = await appFor(storage).request('/media?prefix=folder/');

    expect(res.status).toBe(200);
    expect(storage.list).toHaveBeenCalledWith('sites/site-a/media/folder/');
    await expect(res.json()).resolves.toEqual({ data: ['folder/a.txt'] });
  });

  it('scopes read, write, and delete operations to the authenticated site namespace', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);
    const storage = mockStorage({
      get: vi.fn(async () => ({ body: Buffer.from('ok'), size: 2, contentType: 'text/plain' })),
    });
    const app = appFor(storage);

    expect((await app.request('/media/site-b/secret.txt')).status).toBe(200);
    expect(storage.get).toHaveBeenCalledWith('sites/site-a/media/site-b/secret.txt');

    const post = await app.request('/media/site-b/secret.txt', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'owned',
    });
    expect(post.status).toBe(201);
    expect(storage.put).toHaveBeenCalledWith(
      'sites/site-a/media/site-b/secret.txt',
      Buffer.from('owned'),
      { contentType: 'text/plain' },
    );
    await expect(post.json()).resolves.toMatchObject({ data: { key: 'site-b/secret.txt' } });

    expect((await app.request('/media/site-b/secret.txt', { method: 'DELETE' })).status).toBe(204);
    expect(storage.delete).toHaveBeenCalledWith('sites/site-a/media/site-b/secret.txt');
  });
});

function appFor(storage: ReturnType<typeof mockStorage>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site-a');
    c.set('auth', { userId: 'user-a', email: 'a@example.test', roles: [], raw: {} });
    c.set('db', {} as never);
    c.set('runtime', { storage, cache: undefined } as never);
    await next();
  });
  app.route('/media', mediaRouter);
  return app;
}

function mockStorage(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => ({ keys: [] })),
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}
