import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';

/**
 * #346 (hardening ported from #805): an OAuth access token on the MCP resource
 * becomes a principal whose `raw` is built field by field. Guards elsewhere read
 * `raw.dev`, `raw.aud` and `raw.isBootstrap`; a claim minted by an outside
 * authorization server must not be able to set them.
 */

const RESOURCE = 'https://cms.acme.com/api/v1/mcp';

vi.mock('../../modules/external-auth/adapter', () => ({
  tryExternalJwt: vi.fn(async () => ({
    kind: 'authenticated',
    userId: 'usr_1',
    externalId: 'ext-1',
    email: 'u@acme.com',
    roleIds: ['role_editor'],
    payload: {
      iss: 'https://auth.acme.com/oidc',
      sub: 'ext-1',
      aud: [RESOURCE, 'frontend'],
      scope: 'mcp:read mcp:write',
      azp: 'client_1',
      dev: true,
      isBootstrap: true,
    },
  })),
}));

const { withAuth } = await import('../auth');

function app(): Hono<AppEnv> {
  const fluent = { from: () => fluent, where: () => fluent, limit: () => Promise.resolve([]) };
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', { select: () => fluent } as unknown as Database);
    c.set('siteId', 'site_1');
    c.env = { LUMIBASE_PUBLIC_URL: 'https://cms.acme.com' } as never;
    await next();
  });
  a.use('*', withAuth());
  a.all('*', (c) => c.json({ auth: c.get('auth') }));
  return a;
}

describe('withAuth — MCP OAuth principal', () => {
  it('carries scopes and a field-by-field raw (dev/isBootstrap claims dropped, verified aud kept) on the MCP resource', async () => {
    const res = await app().request('/api/v1/mcp', { method: 'POST', headers: { authorization: 'Bearer ext.jwt.token' } });
    expect(res.status).toBe(200);
    const { auth } = (await res.json()) as { auth: { raw: Record<string, unknown>; oauth: Record<string, unknown> } };
    expect(auth.oauth).toEqual({
      issuer: 'https://auth.acme.com/oidc',
      resource: RESOURCE,
      scopes: ['mcp:read', 'mcp:write'],
      clientId: 'client_1',
    });
    expect(auth.raw).toEqual({ mcpOAuth: true, iss: 'https://auth.acme.com/oidc', sub: 'ext-1', aud: [RESOURCE, 'frontend'] });
    expect(auth.raw.dev).toBeUndefined();
    expect(auth.raw.isBootstrap).toBeUndefined();
  });

  it('leaves non-MCP external principals unchanged (no oauth marker)', async () => {
    const res = await app().request('/api/v1/items/posts', { headers: { authorization: 'Bearer ext.jwt.token' } });
    const { auth } = (await res.json()) as { auth: { oauth?: unknown } };
    expect(auth.oauth).toBeUndefined();
  });
});
