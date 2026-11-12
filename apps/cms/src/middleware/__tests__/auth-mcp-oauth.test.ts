import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { withAuth } from '../auth';

/**
 * `withAuth` accepting an OAuth 2.1 access token on the MCP route (#346),
 * verified against a real JWKS served over HTTP.
 */

const RESOURCE = 'https://cms.example.com/api/v1/mcp';
let server: Server;
let env: Record<string, string>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'ES256', kid: 'k1' }] });
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(jwks));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env = { MCP_OAUTH_ISSUER: origin, MCP_OAUTH_JWKS_URI: `${origin}/jwks.json`, MCP_OAUTH_RESOURCE: RESOURCE, JWT_SECRET: 'unused' };
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ scope: 'lumibase.read', site_id: 'site-a', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(env.MCP_OAUTH_ISSUER!)
    .setAudience(RESOURCE)
    .setSubject('user-1')
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** Answers `select…limit()` calls in order; swallows the audit insert. */
function fakeDb(selectResults: unknown[][]): Database {
  const queue = [...selectResults];
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(queue.shift() ?? []),
    // The trusted-issuer lookup awaits the query without `.limit()`; this site has none.
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };
  return { select: () => fluent, insert: () => ({ values: () => Promise.resolve() }) } as unknown as Database;
}

const ACTIVE = { id: 'user-1', email: 'editor@example.com', status: 'active', tokenVersion: 2 };

async function request(path: string, bearer: string, rows: unknown[][], bindings = env) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb(rows));
    c.set('siteId', 'site-a');
    await next();
  });
  app.use('*', withAuth());
  app.all('*', (c) => c.json({ data: c.get('auth') }));
  const res = await app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } }, bindings);
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
}

describe('withAuth — MCP OAuth access token', () => {
  it('resolves the token to the existing user, carrying only vetted fields in raw', async () => {
    // First select is the API-key lookup (no match), second is the user.
    const { status, body } = await request('/api/v1/mcp', await token({ dev: true, isBootstrap: true, token_version: 2 }), [[], [ACTIVE]]);
    expect(status).toBe(200);
    expect(body.data).toEqual({
      type: 'user',
      userId: 'user-1',
      email: 'editor@example.com',
      roles: [],
      raw: { mcpOAuth: true, iss: env.MCP_OAUTH_ISSUER, scopes: ['lumibase.read'] },
    });
  });

  it('is not a credential anywhere but the MCP route', async () => {
    const { status } = await request('/api/v1/items/posts', await token(), [[], [ACTIVE]]);
    expect(status).toBe(401);
  });

  it('is ignored when the operator has not configured an authorization server', async () => {
    const { status } = await request('/api/v1/mcp', await token(), [[], [ACTIVE]], { JWT_SECRET: 'unused' });
    expect(status).toBe(401);
  });

  it('rejects an unknown or inactive user', async () => {
    expect((await request('/api/v1/mcp', await token(), [[], []])).status).toBe(401);
    expect((await request('/api/v1/mcp', await token(), [[], [{ ...ACTIVE, status: 'suspended' }]])).status).toBe(401);
  });

  it('rejects a token pinned to a superseded token version', async () => {
    expect((await request('/api/v1/mcp', await token({ token_version: 1 }), [[], [ACTIVE]])).status).toBe(401);
  });

  it('rejects a token bound to another site with 403', async () => {
    expect((await request('/api/v1/mcp', await token({ site_id: 'site-b' }), [[], [ACTIVE]])).status).toBe(403);
  });
});
