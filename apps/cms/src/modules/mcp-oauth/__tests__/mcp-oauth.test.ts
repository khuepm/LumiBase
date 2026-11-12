import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AppEnv } from '../../../env';
import { readMcpOAuthConfig, type McpOAuthConfig } from '../config';
import { protectedResourceMetadataHandler, withMcpOAuthChallenge } from '../http';
import { protectedResourceMetadataUrl } from '../metadata';
import { MCP_SCOPE, narrowCapabilitiesByScopes, parseScopes } from '../scopes';
import { verifyMcpAccessToken } from '../verifier';

const config: McpOAuthConfig = {
  issuer: 'https://connect.example.com',
  jwksUri: 'https://connect.example.com/jwks.json',
  resource: 'https://cms.example.com/api/v1/mcp',
  subject: 'user_id',
};

let jwks: JWTVerifyGetKey;
let privateKey: CryptoKey;
let foreignKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  foreignKey = (await generateKeyPair('ES256')).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'ES256' }] });
});

interface Overrides {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  key?: CryptoKey;
  claims?: Record<string, unknown>;
  subject?: string | null;
}

function sign(o: Overrides = {}) {
  const jwt = new SignJWT({ scope: 'lumibase.read', site_id: 'site-a', ...o.claims })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(o.issuer ?? config.issuer)
    .setAudience(o.audience ?? config.resource)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '5m');
  if (o.subject !== null) jwt.setSubject(o.subject ?? 'user-1');
  return jwt.sign(o.key ?? privateKey);
}

const verify = (token: string, requestSiteId: string | undefined = 'site-a') =>
  verifyMcpAccessToken(token, { config, jwks, requestSiteId });

describe('verifyMcpAccessToken', () => {
  it('accepts a token for this resource and returns subject and scopes', async () => {
    const out = await verify(await sign({ claims: { scope: 'lumibase.read lumibase.write', token_version: 3 } }));
    expect(out).toEqual({
      kind: 'verified',
      token: { subject: 'user-1', scopes: ['lumibase.read', 'lumibase.write'], email: undefined, tokenVersion: 3 },
    });
  });

  it('skips tokens that are not from the configured issuer', async () => {
    expect(await verify(await sign({ issuer: 'https://other.example.com' }))).toEqual({ kind: 'skip' });
    expect(await verify('lbk_not-a-jwt')).toEqual({ kind: 'skip' });
  });

  it('rejects a token minted for another audience (no pass-through)', async () => {
    expect(await verify(await sign({ audience: 'https://cms.example.com/api/v1/items' }))).toMatchObject({
      kind: 'rejected', status: 401, code: 'TOKEN_INVALID',
    });
  });

  it('rejects a token signed by a key outside the JWKS', async () => {
    expect(await verify(await sign({ key: foreignKey }))).toMatchObject({ kind: 'rejected', code: 'TOKEN_INVALID' });
  });

  it('rejects an expired token and one without a subject', async () => {
    expect(await verify(await sign({ expiresIn: '-1m' }))).toMatchObject({ kind: 'rejected', code: 'TOKEN_INVALID' });
    expect(await verify(await sign({ subject: null }))).toMatchObject({ kind: 'rejected', code: 'TOKEN_INVALID' });
  });

  it('rejects a symmetric-algorithm token claiming the issuer', async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.issuer).setAudience(config.resource).setSubject('user-1').setExpirationTime('5m')
      .sign(new TextEncoder().encode('secret'));
    expect(await verify(hs)).toMatchObject({ kind: 'rejected', code: 'ALG_NOT_ALLOWED' });
  });

  it('rejects a site-bound token replayed against another site', async () => {
    expect(await verify(await sign(), 'site-b')).toMatchObject({ kind: 'rejected', status: 403, code: 'SITE_MISMATCH' });
  });
});

describe('scopes', () => {
  const held = ['items:read', 'items:write', 'items:update', 'translations:write', 'schema:read', 'schema:create', 'access:delete'];

  it('parses scope and scp claims', () => {
    expect(parseScopes('a  b', ['b', 'c', 1])).toEqual(['a', 'b', 'c']);
  });

  it('grants nothing without a recognised scope', () => {
    expect(narrowCapabilitiesByScopes(held, [])).toEqual([]);
    expect(narrowCapabilitiesByScopes(held, ['openid'])).toEqual([]);
  });

  it('read keeps only :read capabilities', () => {
    expect(narrowCapabilitiesByScopes(held, [MCP_SCOPE.read])).toEqual(['items:read', 'schema:read']);
  });

  it('write adds content writes but no schema or access writes', () => {
    expect(narrowCapabilitiesByScopes(held, [MCP_SCOPE.write])).toEqual([
      'items:read', 'items:write', 'items:update', 'translations:write', 'schema:read',
    ]);
  });

  it('narrows an unlimited admin bundle instead of dropping or keeping it whole', () => {
    const universe = ['items:read', 'items:write', 'schema:create', 'items:read'];
    expect(narrowCapabilitiesByScopes(['admin'], [MCP_SCOPE.read], universe)).toEqual(['items:read']);
    expect(narrowCapabilitiesByScopes(['*'], [MCP_SCOPE.write], universe)).toEqual(['items:read', 'items:write']);
    expect(narrowCapabilitiesByScopes(['admin'], [MCP_SCOPE.admin], universe)).toEqual(['admin']);
  });

  it('admin keeps everything held and never adds a capability', () => {
    expect(narrowCapabilitiesByScopes(held, [MCP_SCOPE.admin])).toEqual(held);
    expect(narrowCapabilitiesByScopes(['items:read'], [MCP_SCOPE.admin])).toEqual(['items:read']);
  });
});

describe('config', () => {
  it('is off unless issuer, JWKS URI and resource are all valid', () => {
    expect(readMcpOAuthConfig({})).toBeNull();
    expect(readMcpOAuthConfig({ MCP_OAUTH_ISSUER: config.issuer, MCP_OAUTH_JWKS_URI: config.jwksUri })).toBeNull();
    expect(readMcpOAuthConfig({
      MCP_OAUTH_ISSUER: 'http://connect.example.com', MCP_OAUTH_JWKS_URI: config.jwksUri, MCP_OAUTH_RESOURCE: config.resource,
    })).toBeNull();
    expect(readMcpOAuthConfig({
      MCP_OAUTH_ISSUER: config.issuer, MCP_OAUTH_JWKS_URI: config.jwksUri, MCP_OAUTH_RESOURCE: config.resource,
    })).toEqual(config);
  });
});

describe('discovery', () => {
  const env = { MCP_OAUTH_ISSUER: config.issuer, MCP_OAUTH_JWKS_URI: config.jwksUri, MCP_OAUTH_RESOURCE: config.resource };
  const app = new Hono<AppEnv>();
  app.get('/.well-known/oauth-protected-resource/*', protectedResourceMetadataHandler);
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);
  app.use('/api/v1/mcp', withMcpOAuthChallenge());
  app.post('/api/v1/mcp', (c) => c.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, 401));

  it('serves protected-resource metadata at the RFC 9728 path', async () => {
    expect(protectedResourceMetadataUrl(config)).toBe('https://cms.example.com/.well-known/oauth-protected-resource/api/v1/mcp');
    const res = await app.request('/.well-known/oauth-protected-resource/api/v1/mcp', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: config.resource, authorization_servers: [config.issuer] });
    expect((await app.request('/.well-known/oauth-protected-resource', {}, env)).status).toBe(200);
    expect((await app.request('/.well-known/oauth-protected-resource/api/v1/items', {}, env)).status).toBe(404);
  });

  it('stays dark when OAuth is not configured', async () => {
    expect((await app.request('/.well-known/oauth-protected-resource', {}, {})).status).toBe(404);
    const res = await app.request('/api/v1/mcp', { method: 'POST' }, {});
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('challenges a 401 with the metadata URL', async () => {
    const res = await app.request('/api/v1/mcp', { method: 'POST' }, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://cms.example.com/.well-known/oauth-protected-resource/api/v1/mcp"',
    );
  });
});
