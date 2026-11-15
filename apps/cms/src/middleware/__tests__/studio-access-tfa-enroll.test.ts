import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTfaEnrollmentRequest, withStudioAccess } from '../studio-access';
import type { AppEnv } from '../../env';
import type { PermissionBundle } from '../../services/permission-service';

/**
 * #735 — `enforceTfa` must be satisfiable: a Studio user with no second factor
 * reaches the enrollment endpoints (TOTP and passkey) and nothing else, and a
 * passkey-opened session (`amr: ['webauthn']`) passes the gate.
 */

const bundleMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: bundleMock };
  }),
}));

const bundle: PermissionBundle = {
  admin: false,
  appAccess: true,
  tfaRequired: true,
  byKey: {},
  roles: [],
  policies: [],
};

function dbWithTfa(tfa: unknown): AppEnv['Variables']['db'] {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ tfa }] }) }) }),
  } as unknown as AppEnv['Variables']['db'];
}

function app(tfa: unknown, raw: Record<string, unknown>) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('auth', { userId: 'u1', email: 'u@example.test', raw } as never);
    c.set('siteId', 'site-1');
    c.set('db', dbWithTfa(tfa));
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    await next();
  });
  a.use('*', withStudioAccess());
  a.all('*', (c) => c.json({ ok: true }));
  return a;
}

const studio = { 'x-lumi-client': 'studio' };

beforeEach(() => {
  bundleMock.mockReset();
  bundleMock.mockResolvedValue(bundle);
});

describe('enforceTfa and enrollment', () => {
  it.each([
    ['GET', '/api/v1/me/tfa'],
    ['POST', '/api/v1/me/tfa/setup'],
    ['POST', '/api/v1/me/tfa/confirm'],
    ['GET', '/api/v1/me/passkeys'],
    ['POST', '/api/v1/me/passkeys/registration-options'],
    ['POST', '/api/v1/me/passkeys'],
  ])('lets an un-enrolled user %s %s', async (method, path) => {
    const res = await app({}, { amr: ['pwd'] }).request(path, { method, headers: studio });
    expect(res.status).toBe(200);
  });

  it.each([
    ['GET', '/api/v1/roles'],
    ['DELETE', '/api/v1/me/passkeys/pk_1'],
    ['POST', '/api/v1/me/passkeys/recovery-codes'],
    ['GET', '/api/v1/me/sessions'],
  ])('still blocks an un-enrolled user on %s %s', async (method, path) => {
    const res = await app({}, { amr: ['pwd'] }).request(path, { method, headers: studio });
    expect(res.status).toBe(403);
  });

  it('once enrolled, a password-only session is blocked even on enrollment paths', async () => {
    const res = await app({ enabled: true, method: 'webauthn' }, { amr: ['pwd'] })
      .request('/api/v1/me/passkeys', { method: 'POST', headers: studio });
    expect(res.status).toBe(403);
  });

  it('a passkey session satisfies enforceTfa', async () => {
    const res = await app({ enabled: true, method: 'webauthn' }, { amr: ['webauthn'], tfaVerified: true })
      .request('/api/v1/roles', { headers: studio });
    expect(res.status).toBe(200);
  });

  it('matches exact method + path only', () => {
    expect(isTfaEnrollmentRequest('post', '/api/v1/me/passkeys/')).toBe(true);
    expect(isTfaEnrollmentRequest('DELETE', '/api/v1/me/tfa')).toBe(false);
    expect(isTfaEnrollmentRequest('POST', '/api/v1/me/passkeys/x')).toBe(false);
  });
});
