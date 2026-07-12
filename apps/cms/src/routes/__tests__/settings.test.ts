import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsRouter } from '../settings';
import { PermissionService } from '../../services/permission-service';
import type { AppEnv } from '../../env';

function mockDb(rows: unknown[] = []) {
  const returning = vi.fn(async () => [{ id: 's1', key: 'k', value: {} }]);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  // Supports both `.where(...)` (list) and `.where(...).limit(1)` (by key).
  const select = () => ({
    from: () => ({
      where: () => {
        const p = Promise.resolve(rows);
        return Object.assign(p, { limit: async () => rows });
      },
    }),
  });
  const del = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: 's1' }] }) }));
  return { insert, values, select, delete: del };
}

function appFor(auth: Record<string, unknown>, db = mockDb()) {
  const app = new Hono<AppEnv>();
  const cache = { get: async () => null, set: async () => undefined, delete: async () => undefined };
  app.use('*', async (c, next) => {
    c.set('siteId', 'site-a');
    c.set('auth', auth as never);
    c.set('db', db as never);
    c.set('runtime', { cache } as never);
    await next();
  });
  app.route('/settings', settingsRouter);
  return { app, db };
}

describe('settingsRouter authorization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets any authenticated member READ settings (non-admin editors need this)', async () => {
    const { app } = appFor({ userId: 'u1', roles: ['editor'], raw: {} });
    const res = await app.request('/settings');
    expect(res.status).toBe(200);
  });

  it('redacts secret-bearing fields on read (key + nested) but keeps other values', async () => {
    const row = {
      id: 's1',
      key: 'media.signedTransform',
      value: { enabled: true, presetOnly: false, secret: 'super-secret-hmac-key', nested: { apiKey: 'abc', label: 'ok' } },
    };
    const { app } = appFor({ userId: 'u1', roles: ['editor'], raw: {} }, mockDb([row]));

    const res = await app.request('/settings/media.signedTransform');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { value: Record<string, unknown> } };
    expect(body.data.value.secret).toBe('[redacted]');
    expect((body.data.value.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((body.data.value.nested as Record<string, unknown>).label).toBe('ok');
    expect(body.data.value.enabled).toBe(true);
  });

  it('redacts secrets in the list response too', async () => {
    const rows = [{ id: 's1', key: 'media.signedTransform', value: { secret: 'x', enabled: true } }];
    const { app } = appFor({ userId: 'u1', roles: ['editor'], raw: {} }, mockDb(rows));
    const res = await app.request('/settings');
    const body = (await res.json()) as { data: Array<{ value: Record<string, unknown> }> };
    expect(body.data[0]!.value.secret).toBe('[redacted]');
    expect(body.data[0]!.value.enabled).toBe(true);
  });

  it('forbids a non-admin from WRITING settings', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({ admin: false } as never);
    const { app, db } = appFor({ userId: 'u1', roles: ['editor'], raw: {} });
    const res = await app.request('/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'upload_policy', value: { maxBytes: 999999999 } }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('forbids a non-admin from DELETING a setting', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({ admin: false } as never);
    const { app, db } = appFor({ userId: 'u1', roles: ['editor'], raw: {} });
    const res = await app.request('/settings/upload_policy', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('allows a site admin to write settings', async () => {
    // Dev-admin shortcut in requireSiteAdmin avoids constructing PermissionService.
    const { app, db } = appFor({ roles: ['admin'], raw: { dev: true } });
    const res = await app.request('/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'upload_policy', value: { maxBytes: 5242880 } }),
    });
    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalled();
  });
});
