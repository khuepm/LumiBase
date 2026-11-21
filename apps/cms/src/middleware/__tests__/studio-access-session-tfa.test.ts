import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withStudioAccess } from '../studio-access';
import type { AppEnv, AuthPrincipal } from '../../env';
import type { PermissionBundle } from '../../services/permission-service';

/**
 * #987 — `enforceTfa` is a property of the session, not of the client. A
 * policy that requires a TFA-verified session must hold on content, file,
 * flow, AI and MCP routes too, for any client — not only for requests that
 * identify themselves as Studio or hit a Studio management prefix.
 */

const bundleMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: bundleMock };
  }),
}));

function bundle(overrides: Partial<PermissionBundle> = {}): PermissionBundle {
  return {
    admin: false,
    appAccess: false,
    tfaRequired: true,
    byKey: {},
    roles: [],
    policies: [],
    ...overrides,
  };
}

function dbWithTfa(tfa: unknown): AppEnv['Variables']['db'] {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ tfa }] }) }) }),
  } as unknown as AppEnv['Variables']['db'];
}

function app(auth: AuthPrincipal | undefined, tfa: unknown, siteId: string | null = 'site-1') {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    if (siteId) c.set('siteId', siteId);
    c.set('db', dbWithTfa(tfa));
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    await next();
  });
  a.use('*', withStudioAccess());
  a.all('*', (c) => c.json({ ok: true }));
  return a;
}

const user = (raw: Record<string, unknown>): AuthPrincipal => ({ userId: 'u1', email: 'u@example.test', raw });
const enrolled = { enabled: true, method: 'totp' };

// No Studio header, no Studio User-Agent: a script, SDK or curl client.
const CONTENT_ROUTES: Array<[string, string]> = [
  ['POST', '/api/v1/items/articles'],
  ['PATCH', '/api/v1/items/articles/a1'],
  ['GET', '/api/v1/items/articles'],
  ['POST', '/api/v1/files'],
  ['PUT', '/api/v1/media/k1'],
  ['POST', '/api/v1/flows'],
  ['POST', '/api/v1/ai/chat'],
  ['POST', '/api/v1/mcp'],
  ['POST', '/api/v1/imports'],
  ['POST', '/api/v1/releases'],
];

beforeEach(() => {
  bundleMock.mockReset();
  bundleMock.mockResolvedValue(bundle());
});

describe('enforceTfa outside the Studio surface', () => {
  it.each(CONTENT_ROUTES)('blocks an un-enrolled user on %s %s', async (method, path) => {
    const res = await app(user({ amr: ['pwd'] }), {}).request(path, { method });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('TFA_REQUIRED');
  });

  it.each(CONTENT_ROUTES)('blocks an enrolled user with a password-only session on %s %s', async (method, path) => {
    const res = await app(user({ amr: ['pwd'] }), enrolled).request(path, { method });
    expect(res.status).toBe(403);
  });

  it.each(CONTENT_ROUTES)('lets a TFA-verified session through on %s %s', async (method, path) => {
    const res = await app(user({ amr: ['pwd', 'totp'], tfaVerified: true }), enrolled).request(path, { method });
    expect(res.status).toBe(200);
  });

  it('lets an un-enrolled user reach the enrollment endpoints', async () => {
    const res = await app(user({ amr: ['pwd'] }), {}).request('/api/v1/me/tfa/setup', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('does not gate a session whose policies do not require TFA', async () => {
    bundleMock.mockResolvedValue(bundle({ tfaRequired: false }));
    const res = await app(user({ amr: ['pwd'] }), {}).request('/api/v1/items/articles', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('does not apply to API keys (non-interactive credentials)', async () => {
    const key: AuthPrincipal = { type: 'api_key', apiKeyId: 'k1', userId: 'u1', raw: {} };
    const res = await app(key, {}).request('/api/v1/items/articles', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(bundleMock).not.toHaveBeenCalled();
  });

  it('does not apply to anonymous principals', async () => {
    const anon: AuthPrincipal = { type: 'anonymous', roleId: 'public', raw: {} };
    const res = await app(anon, {}).request('/api/v1/items/articles');
    expect(res.status).toBe(200);
    expect(bundleMock).not.toHaveBeenCalled();
  });

  it('leaves the public auth routes reachable', async () => {
    for (const path of ['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout', '/api/v1/auth/verify-totp']) {
      const res = await app(user({ amr: ['pwd'] }), {}).request(path, { method: 'POST' });
      expect(res.status, path).toBe(200);
    }
  });

  it('does nothing without a site (policies are site-scoped)', async () => {
    const res = await app(user({ amr: ['pwd'] }), {}, null).request('/api/v1/items/articles', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(bundleMock).not.toHaveBeenCalled();
  });

  it('keeps the appAccess wall Studio-only: a non-Studio content call never needs appAccess', async () => {
    bundleMock.mockResolvedValue(bundle({ tfaRequired: false, appAccess: false }));
    const res = await app(user({}), {}).request('/api/v1/items/articles', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
