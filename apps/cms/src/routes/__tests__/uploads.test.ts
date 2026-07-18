import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadsRouter } from '../uploads';
import { PermissionService } from '../../services/permission-service';
import type { AppEnv } from '../../env';

function mockDb() {
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return {
    insert,
    values,
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
}

function appFor(auth: Record<string, unknown>, db = mockDb()) {
  const app = new Hono<AppEnv>();
  const cache = { get: async () => null, set: async () => undefined, delete: async () => undefined };
  app.use('*', async (c, next) => {
    c.set('siteId', 'site-a');
    c.set('auth', auth as never);
    c.set('db', db as never);
    c.set('runtime', { storage: undefined, cache } as never);
    await next();
  });
  app.route('/uploads', uploadsRouter);
  return { app, db };
}

describe('uploadsRouter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the effective config plus the type catalogue', async () => {
    const { app } = appFor({ roles: ['editor'], raw: {} });
    const res = await app.request('/uploads/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { maxBytes: number; allowedMimeTypes: string[]; allowedExtensions: string[]; catalogue: { mime: string }[] };
    };
    expect(body.data.maxBytes).toBeGreaterThan(0);
    expect(Array.isArray(body.data.allowedMimeTypes)).toBe(true);
    expect(Array.isArray(body.data.allowedExtensions)).toBe(true);
    expect(body.data.catalogue.some((e) => e.mime === 'image/png')).toBe(true);
  });

  it('lets a site admin narrow the allowlist', async () => {
    // Dev-admin shortcut in requireSiteAdmin avoids constructing PermissionService.
    const { app, db } = appFor({ roles: ['admin'], raw: { dev: true } });
    const res = await app.request('/uploads/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedMimeTypes: ['image/png'], maxBytes: 5242880 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { allowedMimeTypes: string[]; maxBytes: number } };
    expect(body.data.allowedMimeTypes).toEqual(['image/png']);
    expect(body.data.maxBytes).toBe(5242880);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'upload_policy', siteId: 'site-a' }),
    );
  });

  it('rejects a non-admin attempting to change the policy', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({ admin: false } as never);
    const { app, db } = appFor({ userId: 'u1', roles: ['editor'], raw: {} });
    const res = await app.request('/uploads/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedMimeTypes: ['image/png'] }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a MIME type outside the catalogue', async () => {
    const { app } = appFor({ roles: ['admin'], raw: { dev: true } });
    const res = await app.request('/uploads/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedMimeTypes: ['application/x-msdownload'] }),
    });
    expect(res.status).toBe(400);
  });
});
