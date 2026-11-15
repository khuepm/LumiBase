import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/**
 * #346 — RFC 9728 discovery surface for the remote MCP endpoint:
 *  - `/.well-known/oauth-protected-resource[...]` metadata (tenant-resolved, public);
 *  - `WWW-Authenticate: Bearer resource_metadata=…` on every MCP 401;
 *  - `/api/v1/mcp/sites/<id>` resolving the tenant from the path.
 */

const flags = { mcp: true };
vi.mock('../../services/feature-flags', () => ({
  getContentOsFlags: vi.fn(async () => flags),
}));

const { protectedResourceRouter } = await import('../oauth-protected-resource');
const { withTenant } = await import('../../middleware/tenant');
const { withMcpAuthChallenge } = await import('../../middleware/mcp-oauth');

const BASE = 'https://cms.acme.com';
let issuerRows: Array<{ issuer: string; audience: unknown; enabled: boolean }> = [];

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.env = { LUMIBASE_PUBLIC_URL: BASE } as never;
    c.set('runtime', { cache: undefined } as never);
    c.set('db', { select: () => ({ from: () => ({ where: async () => issuerRows }) }) } as never);
    await next();
  });
  a.use('/.well-known/oauth-protected-resource', withTenant());
  a.use('/.well-known/oauth-protected-resource/*', withTenant());
  a.route('/.well-known/oauth-protected-resource', protectedResourceRouter);

  const api = new Hono<AppEnv>();
  api.use('/mcp', withMcpAuthChallenge());
  api.use('/mcp/*', withMcpAuthChallenge());
  api.use('*', withTenant());
  // Stand-in for `withAuth` rejecting an unauthenticated caller.
  api.post('/mcp', (c) => c.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, 401));
  api.post('/mcp/sites/:siteId', (c) =>
    c.req.header('authorization') ? c.json({ siteId: c.get('siteId') }) : c.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, 401),
  );
  api.post('/items', (c) => c.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, 401));
  a.route('/api/v1', api);
  return a;
}

describe('Protected Resource Metadata', () => {
  beforeEach(() => {
    flags.mcp = true;
    issuerRows = [
      { issuer: 'https://auth.acme.com/oidc', audience: [`${BASE}/api/v1/mcp/sites/site_1`, `${BASE}/api/v1/mcp`], enabled: true },
      { issuer: 'https://unrelated.example', audience: 'lumibase-api', enabled: true },
    ];
  });

  it('serves the site-addressed document with only matching issuers', async () => {
    const res = await app().request('/.well-known/oauth-protected-resource/api/v1/mcp/sites/site_1');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({
      resource: `${BASE}/api/v1/mcp/sites/site_1`,
      authorization_servers: ['https://auth.acme.com/oidc'],
      bearer_methods_supported: ['header'],
    });
  });

  it('serves the base document (site from X-Lumi-Site / host)', async () => {
    const res = await app().request('/.well-known/oauth-protected-resource/api/v1/mcp', { headers: { 'x-lumi-site': 'site_1' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource: string }).resource).toBe(`${BASE}/api/v1/mcp`);
  });

  it('404s when no issuer is configured for the resource', async () => {
    issuerRows = [{ issuer: 'https://unrelated.example', audience: 'lumibase-api', enabled: true }];
    const res = await app().request('/.well-known/oauth-protected-resource/api/v1/mcp/sites/site_1');
    expect(res.status).toBe(404);
  });

  it('404s when the site has MCP disabled', async () => {
    flags.mcp = false;
    const res = await app().request('/.well-known/oauth-protected-resource/api/v1/mcp/sites/site_1');
    expect(res.status).toBe(404);
  });

  it('rejects an X-Lumi-Site that contradicts the path', async () => {
    const res = await app().request('/.well-known/oauth-protected-resource/api/v1/mcp/sites/site_1', {
      headers: { 'x-lumi-site': 'site_2' },
    });
    expect(res.status).toBe(400);
  });
});

describe('MCP 401 discovery challenge', () => {
  it('adds resource_metadata to the base endpoint 401', async () => {
    const res = await app().request('/api/v1/mcp', { method: 'POST', headers: { 'x-lumi-site': 'site_1' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/v1/mcp"`,
    );
  });

  it('adds the site-addressed metadata URL on the site endpoint 401', async () => {
    const res = await app().request('/api/v1/mcp/sites/site_1', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/v1/mcp/sites/site_1"`,
    );
  });

  it('resolves the tenant from the site path', async () => {
    const res = await app().request('/api/v1/mcp/sites/site_1', { method: 'POST', headers: { authorization: 'Bearer x' } });
    expect(await res.json()).toEqual({ siteId: 'site_1' });
  });

  it('leaves non-MCP 401s alone', async () => {
    const res = await app().request('/api/v1/items', { method: 'POST', headers: { 'x-lumi-site': 'site_1' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});
