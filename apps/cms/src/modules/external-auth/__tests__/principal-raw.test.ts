import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../../env';
import { RESERVED_PRINCIPAL_CLAIMS, externalPrincipalRaw } from '../principal-raw';

/**
 * An external issuer is trusted for identity, not for LumiBase's own principal
 * markers. A `dev` / `isBootstrap` / `tfaVerified` claim must not survive onto
 * `auth.raw`, where admin-bypass and 2FA guards read them.
 */

describe('externalPrincipalRaw', () => {
  it('drops every reserved marker and keeps the issuer claims', () => {
    const payload = {
      iss: 'https://idp.example.com/',
      sub: 'ext-1',
      aud: 'lumibase-api',
      email: 'u@x.dev',
      amr: ['pwd', 'otp'],
      acr: 'mfa',
      mfa: true,
      roles: ['editor'],
      ...Object.fromEntries(RESERVED_PRINCIPAL_CLAIMS.map((k) => [k, true])),
    };
    const raw = externalPrincipalRaw(payload);
    for (const key of RESERVED_PRINCIPAL_CLAIMS) expect(raw).not.toHaveProperty(key);
    expect(raw).toEqual({
      iss: 'https://idp.example.com/',
      sub: 'ext-1',
      aud: 'lumibase-api',
      email: 'u@x.dev',
      amr: ['pwd', 'otp'],
      acr: 'mfa',
      mfa: true,
      roles: ['editor'],
    });
  });

  it('returns a fresh object (the verified payload is not mutated)', () => {
    const payload = { sub: 'a', dev: true };
    const raw = externalPrincipalRaw(payload);
    expect(raw).not.toBe(payload);
    expect(payload.dev).toBe(true);
  });
});

vi.mock('../adapter', () => ({
  tryExternalJwt: vi.fn(async () => ({
    kind: 'authenticated',
    userId: 'usr_1',
    externalId: 'ext-1',
    email: 'u@x.dev',
    roleIds: ['admin'],
    payload: { iss: 'https://idp.example.com/', sub: 'ext-1', aud: 'lumibase-api', dev: true, isBootstrap: true, tfaVerified: true },
  })),
}));

describe('withAuth — external principal', () => {
  it('does not let a forged dev/isBootstrap/tfaVerified claim reach auth.raw', async () => {
    const { withAuth } = await import('../../../middleware/auth');
    const fluent = { from: () => fluent, where: () => fluent, limit: () => Promise.resolve([]) };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', { select: () => fluent } as unknown as Database);
      c.set('siteId', 'site_1');
      await next();
    });
    app.use('*', withAuth());
    app.all('*', (c) => c.json({ auth: c.get('auth') }));

    const res = await app.request('/api/v1/items/posts', { headers: { authorization: 'Bearer ext.jwt.token' } });
    expect(res.status).toBe(200);
    const { auth } = (await res.json()) as { auth: { raw: Record<string, unknown>; roles: string[] } };
    expect(auth.roles).toEqual(['admin']);
    expect(auth.raw).toEqual({ iss: 'https://idp.example.com/', sub: 'ext-1', aud: 'lumibase-api' });
  });
});
