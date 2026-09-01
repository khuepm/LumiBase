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
      expect.objectContaining({ contentType: 'text/plain' }),
    );
    await expect(post.json()).resolves.toMatchObject({ data: { key: 'site-b/secret.txt' } });

    expect((await app.request('/media/site-b/secret.txt', { method: 'DELETE' })).status).toBe(204);
    expect(storage.delete).toHaveBeenCalledWith('sites/site-a/media/site-b/secret.txt');
  });

  it('serves downloads as attachments and falls back to metadata content-type', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);
    // Simulate an older object that only carries content-type in custom metadata.
    const storage = mockStorage({
      get: vi.fn(async () => ({
        body: Buffer.from('<svg/>'),
        size: 6,
        contentType: undefined,
        metadata: { contentType: 'image/svg+xml' },
      })),
    });

    const res = await appFor(storage).request('/media/evil.svg');

    expect(res.status).toBe(200);
    // Never rendered inline — forced download neutralizes stored HTML/SVG.
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="evil.svg"');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // Content-type recovered from metadata when the native field is absent.
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
  });
});

/**
 * #388 — `immutable` is a promise no cache lets us take back, so it may only be
 * made about a URL that changes when the bytes change. `POST /media/:key`
 * overwrites in place, so the key alone does not qualify; `?v=<contentHash>`
 * is what does.
 */
describe('media cache policy (#388)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bytes = Buffer.from('hello');
  // sha-256("hello"), first 32 hex chars — the fingerprint the upload path writes.
  const version = '2cf24dba5fb0a30e26e83b2ac5b9e29e';

  function storedObject(metadata: Record<string, string> = {}) {
    return mockStorage({
      get: vi.fn(async () => ({
        body: Buffer.from(bytes),
        size: bytes.byteLength,
        contentType: 'image/png',
        metadata: { contentType: 'image/png', ...metadata },
      })),
    });
  }

  it('writes a content fingerprint on upload and returns it to the caller', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);
    const storage = mockStorage();

    const res = await appFor(storage).request('/media/logo.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ data: { version } });
    expect(storage.put).toHaveBeenCalledWith('sites/site-a/media/logo.png', bytes, {
      contentType: 'image/png',
      contentHash: version,
    });
  });

  it('re-uploading different bytes under the same key changes the version', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);
    const storage = mockStorage();
    const app = appFor(storage);

    const upload = async (body: string) => {
      const res = await app.request('/media/logo.png', {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body,
      });
      return (await res.json()) as { data: { version: string } };
    };

    const first = await upload('hello');
    const second = await upload('replaced');

    // The key is identical across both writes — this is exactly the overwrite
    // that made a key-addressed `immutable` URL unrecoverable.
    expect(storage.put).toHaveBeenNthCalledWith(1, 'sites/site-a/media/logo.png', expect.anything(), expect.anything());
    expect(storage.put).toHaveBeenNthCalledWith(2, 'sites/site-a/media/logo.png', expect.anything(), expect.anything());
    expect(second.data.version).not.toBe(first.data.version);
  });

  it('serves an unpinned URL as revalidating, never immutable', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);

    const res = await appFor(storedObject({ contentHash: version })).request('/media/logo.png');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
    expect(res.headers.get('Cache-Control')).not.toContain('immutable');
    expect(res.headers.get('X-Lumi-Media-Version')).toBe(version);
    expect(res.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
  });

  it('serves a URL pinned to the current version as immutable', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);

    const res = await appFor(storedObject({ contentHash: version })).request(`/media/logo.png?v=${version}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('downgrades a stale pin instead of freezing current bytes for a year', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);

    const res = await appFor(storedObject({ contentHash: version })).request('/media/logo.png?v=deadbeef');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
  });

  it('answers a matching If-None-Match with 304 and no body-length header', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);
    const app = appFor(storedObject({ contentHash: version }));

    const first = await app.request('/media/logo.png');
    const etag = first.headers.get('ETag')!;
    const revalidated = await app.request('/media/logo.png', { headers: { 'If-None-Match': etag } });

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('Content-Length')).toBeNull();
  });

  it('never claims immutable for a legacy object that carries no fingerprint', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allowPermission);

    // No `contentHash` in metadata — uploaded before the field existed, or
    // written through the streaming `PUT /files/upload/:key` receiver.
    const res = await appFor(storedObject()).request('/media/logo.png');

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
    expect(res.headers.get('X-Lumi-Media-Version')).toBeNull();
    expect(res.headers.get('ETag')).toBeNull();
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
