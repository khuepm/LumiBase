import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSessionTfaVerified, isTfaEnrolled, withStudioAccess } from '../studio-access';
import type { AppEnv, AuthPrincipal } from '../../env';
import type { PermissionBundle } from '../../services/permission-service';

const bundleMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: bundleMock };
  }),
}));

function principal(raw: Record<string, unknown>): AuthPrincipal {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    raw,
  };
}

function bundle(overrides: Partial<PermissionBundle>): PermissionBundle {
  return {
    admin: false,
    appAccess: true,
    tfaRequired: false,
    byKey: {},
    roles: [],
    policies: [],
    ...overrides,
  };
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', principal({}));
    c.set('siteId', 'site-1');
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('*', withStudioAccess());
  app.post('/api/v1/roles', (c) => c.json({ ok: true }, 201));
  app.post('/api/v1/items/articles', (c) => c.json({ ok: true }, 201));
  return app;
}

describe('studio access TFA helpers', () => {
  it('recognizes common TFA enrollment metadata shapes', () => {
    expect(isTfaEnrolled({ enabled: true })).toBe(true);
    expect(isTfaEnrolled({ enrolled: true })).toBe(true);
    expect(isTfaEnrolled({ verified: true })).toBe(true);
    expect(isTfaEnrolled({ secret: 'totp-secret' })).toBe(true);
    expect(isTfaEnrolled({ tfaSecret: 'totp-secret' })).toBe(true);
    expect(isTfaEnrolled({ enabled: false })).toBe(false);
    expect(isTfaEnrolled(null)).toBe(false);
  });

  it('recognizes MFA-verified sessions from JWT claims', () => {
    expect(isSessionTfaVerified(principal({ tfaVerified: true }))).toBe(true);
    expect(isSessionTfaVerified(principal({ mfa: true }))).toBe(true);
    expect(isSessionTfaVerified(principal({ mfaVerified: true }))).toBe(true);
    expect(isSessionTfaVerified(principal({ amr: ['pwd', 'totp'] }))).toBe(true);
    expect(isSessionTfaVerified(principal({ acr: 'urn:lumibase:mfa' }))).toBe(true);
    expect(isSessionTfaVerified(principal({ amr: ['pwd'] }))).toBe(false);
  });
});

describe('withStudioAccess', () => {
  beforeEach(() => {
    bundleMock.mockReset();
  });

  it('enforces app access on Studio management routes even when the client header is omitted', async () => {
    bundleMock.mockResolvedValue(bundle({ appAccess: false }));

    const res = await createApp().request('/api/v1/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Editors' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      errors: [{ code: 'APP_ACCESS_DENIED', message: 'This account is not allowed to use Studio.' }],
    });
    expect(bundleMock).toHaveBeenCalledTimes(1);
  });

  it('continues to leave unmarked content API calls to downstream permission checks', async () => {
    const res = await createApp().request('/api/v1/items/articles', {
      method: 'POST',
      body: JSON.stringify({ title: 'Hello' }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(bundleMock).not.toHaveBeenCalled();
  });
});
