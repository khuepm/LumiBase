import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import {
  isAdminPrincipal,
  isCoreRbacPath,
  isMimeAllowed,
  isPublicPrincipal,
  resolveUploadMaxBytes,
  resolveUploadMimeAllowlist,
  withCoreRbacGuard,
  withSecurityHeaders,
  withUploadGuard,
} from '../traditional-defense';

describe('traditional defense helpers', () => {
  it('identifies core RBAC control-plane paths', () => {
    expect(isCoreRbacPath('/api/v1/roles')).toBe(true);
    expect(isCoreRbacPath('/api/v1/roles/role-1/users')).toBe(true);
    expect(isCoreRbacPath('/api/v1/items/posts')).toBe(false);
  });

  it('distinguishes admin and public principals', () => {
    expect(isAdminPrincipal({ roles: ['admin'], raw: {} })).toBe(true);
    expect(isAdminPrincipal({ roles: ['member'], raw: {} })).toBe(false);
    expect(isPublicPrincipal(undefined)).toBe(true);
    expect(isPublicPrincipal({ roles: ['public'], raw: {} })).toBe(true);
    expect(isPublicPrincipal({ type: 'api_key', roles: [], raw: {} })).toBe(false);
  });

  it('parses upload limits and MIME allowlists safely', () => {
    expect(resolveUploadMaxBytes('2048')).toBe(2048);
    expect(resolveUploadMaxBytes('-1')).toBe(10 * 1024 * 1024);
    expect(resolveUploadMimeAllowlist('image/*, application/pdf')).toEqual(['image/*', 'application/pdf']);
    expect(isMimeAllowed('image/png; charset=binary', ['image/*'])).toBe(true);
    expect(isMimeAllowed('application/x-msdownload', ['image/*'])).toBe(false);
  });
});

describe('traditional defense middleware', () => {
  it('adds security headers to responses', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withSecurityHeaders());
    app.get('/health', (c) => c.json({ ok: true }));

    const res = await app.request('/health');

    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('audits and fails closed on non-admin access to system routes', async () => {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      c.set('auth', { email: 'member@example.com', roles: ['member'], raw: {} });
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
      await next();
    });
    app.use('*', withCoreRbacGuard());
    app.get('/api/v1/roles', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/roles');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'CORE_RBAC_FORBIDDEN' }] });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      event: 'traditional_defense_denied',
      actorEmail: 'member@example.com',
      siteId: 'site_1',
      requestId: 'req_1',
      metadata: expect.objectContaining({ guard: 'core_rbac', reason: 'non_admin_system_route' }),
    }));
  });

  it('allows admins through the core RBAC guard', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { roles: ['admin'], raw: {} });
      await next();
    });
    app.use('*', withCoreRbacGuard());
    app.get('/api/v1/roles', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/roles');

    expect(res.status).toBe(200);
  });

  it('blocks public-role file metadata uploads', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { roles: ['public'], raw: {} });
      await next();
    });
    app.use('*', withUploadGuard());
    app.post('/api/v1/files', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mime: 'image/png' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'PUBLIC_UPLOAD_FORBIDDEN' }] });
  });

  it('rejects oversized signed upload bodies before storage writes', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withUploadGuard());
    app.put('/api/v1/files/upload/key', (c) => c.json({ ok: true }));

    const previous = process.env.TRADITIONAL_UPLOAD_MAX_BYTES;
    process.env.TRADITIONAL_UPLOAD_MAX_BYTES = '4';
    const res = await app.request('/api/v1/files/upload/key', {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': '5' },
      body: '12345',
    });
    if (previous === undefined) {
      delete process.env.TRADITIONAL_UPLOAD_MAX_BYTES;
    } else {
      process.env.TRADITIONAL_UPLOAD_MAX_BYTES = previous;
    }

    expect(res.status).toBe(413);
  });
});
