import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import type { TrustedIssuer } from '../verifier';

/**
 * #346 — MCP resource audience wall in `tryExternalJwt`, both directions:
 *  - on the MCP endpoint a trusted-issuer token MUST carry this resource URI in
 *    `aud` (no pass-through of a token minted for another API);
 *  - off the MCP endpoint a token whose only audience is an MCP resource is
 *    refused (no replay of a connector token against REST).
 */

let publicKey: CryptoKey;
let privateKey: CryptoKey;

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: () => async () => publicKey };
});

const { tryExternalJwt, issuerCacheKey } = await import('../adapter');

const SITE = 'site_1';
const BASE = 'https://cms.acme.com';
const MCP_RESOURCE = `${BASE}/api/v1/mcp`;
const SITE_RESOURCE = `${BASE}/api/v1/mcp/sites/${SITE}`;
const ISSUER = 'https://auth.acme.com/oidc';

const issuer: TrustedIssuer = {
  id: 'iss_1',
  issuer: ISSUER,
  jwksUri: 'https://auth.acme.com/oidc/jwks',
  discoveryUrl: null,
  audience: ['lumibase-api', MCP_RESOURCE, SITE_RESOURCE],
  algorithms: ['RS256'],
  claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
  roleMapping: {},
  defaultRoleId: 'role_editor',
  jitProvisioning: false,
  clockSkewSeconds: 60,
};

beforeAll(async () => {
  ({ publicKey, privateKey } = await generateKeyPair('RS256'));
});

function sign(aud: string | string[]): Promise<string> {
  return new SignJWT({ email: 'u@acme.com', roles: [], scope: 'mcp:read' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setSubject('ext-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function context(path: string): { c: Context<AppEnv>; provisioned: () => boolean } {
  let inserted = false;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'usr_1', status: 'active' }] }) }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {
          inserted = true;
        },
      }),
    }),
  };
  const cache = {
    get: async (key: string) => (key === issuerCacheKey(SITE) ? [issuer] : null),
    set: async () => undefined,
  };
  const vars: Record<string, unknown> = { db, siteId: SITE, runtime: { cache } };
  const c = {
    get: (key: string) => vars[key],
    env: { LUMIBASE_PUBLIC_URL: BASE },
    req: { path, url: `${BASE}${path}`, header: () => undefined },
  } as unknown as Context<AppEnv>;
  return { c, provisioned: () => inserted };
}

describe('MCP resource audience wall', () => {
  it('accepts an MCP-audience token on the MCP endpoint', async () => {
    const { c } = context('/api/v1/mcp');
    expect((await tryExternalJwt(c, await sign(MCP_RESOURCE))).kind).toBe('authenticated');
  });

  it('accepts the site-addressed resource on the site endpoint', async () => {
    const { c } = context(`/api/v1/mcp/sites/${SITE}`);
    expect((await tryExternalJwt(c, await sign(SITE_RESOURCE))).kind).toBe('authenticated');
  });

  it('refuses token pass-through: an API-audience token on the MCP endpoint, before provisioning', async () => {
    const { c, provisioned } = context('/api/v1/mcp');
    const out = await tryExternalJwt(c, await sign('lumibase-api'));
    expect(out).toMatchObject({ kind: 'rejected', status: 401, code: 'AUDIENCE_NOT_MCP_RESOURCE' });
    expect(provisioned()).toBe(false);
  });

  it('refuses a token for a different MCP resource (base vs site endpoint)', async () => {
    const { c } = context(`/api/v1/mcp/sites/${SITE}`);
    const out = await tryExternalJwt(c, await sign(MCP_RESOURCE));
    expect(out).toMatchObject({ kind: 'rejected', code: 'AUDIENCE_NOT_MCP_RESOURCE' });
  });

  it('refuses an MCP-only token on a REST path', async () => {
    const { c } = context('/api/v1/items/posts');
    const out = await tryExternalJwt(c, await sign(MCP_RESOURCE));
    expect(out).toMatchObject({ kind: 'rejected', status: 401, code: 'AUDIENCE_MCP_ONLY' });
  });

  it('keeps accepting REST-audience tokens on REST paths (unchanged)', async () => {
    const { c } = context('/api/v1/items/posts');
    expect((await tryExternalJwt(c, await sign('lumibase-api'))).kind).toBe('authenticated');
  });

  it('a token minted for both REST and MCP works on both', async () => {
    const token = await sign(['lumibase-api', MCP_RESOURCE]);
    expect((await tryExternalJwt(context('/api/v1/items/posts').c, token)).kind).toBe('authenticated');
    expect((await tryExternalJwt(context('/api/v1/mcp').c, token)).kind).toBe('authenticated');
  });
});
