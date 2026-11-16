import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { createAdaptorServer } from '@hono/node-server';
import Provider, { type KoaContextWithOIDC } from 'oidc-provider';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  UnauthorizedError,
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { and, eq, inArray } from 'drizzle-orm';
import {
  authExternalIssuers,
  organizations,
  settings,
  sites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { provisionSite } from '../services/site-provisioning';
import app from '../index';

/**
 * MCP OAuth 2.1 with a hosted MCP client against a real IdP (#346, #798).
 *
 * The unit/route suites prove each piece. This drives the whole interop path
 * the way a hosted connector (Claude, ChatGPT, IDE remote MCP) does it, over
 * real HTTP and with nothing mocked:
 *
 *   - IdP: `oidc-provider` (OpenID Certified), with open Dynamic Client
 *     Registration, PKCE (S256) required, RFC 8707 resource indicators and
 *     ES256 JWT access tokens. Its own HTTP server and JWKS endpoint.
 *   - Client: the official `@modelcontextprotocol/sdk` client
 *     (`StreamableHTTPClientTransport` + `OAuthClientProvider`). It does the
 *     401 → RFC 9728 → AS metadata → DCR → authorize → token dance itself; the
 *     test only plays the user's browser (login + consent).
 *   - Server: the default LumiBase `app` from `index.ts` — every global and
 *     authenticated middleware layer — over a Node HTTP server, on PostgreSQL.
 *
 * Covered: discovery from the 401 challenge, DCR, PKCE + `resource`, the
 * site-addressed MCP URL, tools/list with annotations, tools/call, scope
 * narrowing with a 403 step-up challenge, audience rejection both ways (a token
 * for another resource on MCP; the MCP token on REST), and refresh.
 *
 * Needs the same env as the golden-path E2E (LUMIBASE_RUNTIME=docker,
 * LUMIBASE_ENV=development, JWT_SECRET, DATABASE_URL). Like it, it touches the
 * instance-wide setup state (a bootstrap user must exist), so CI runs it as its
 * own step in the E2E job rather than inside the parallel integration suites.
 * Skips when DATABASE_URL is unset.
 */

const ORG = 'org_mcp_oauth_e2e';
const SITE = 'site_mcp_oauth_e2e';
const BOOTSTRAP_USER = 'user_mcp_oauth_e2e_bootstrap';
const ACCOUNT = 'idp-user-mcp-oauth-e2e';
const ACCOUNT_EMAIL = 'mcp-oauth-e2e@example.test';
const OTHER_RESOURCE = 'https://other.example.test/api';

const ENV = { ...process.env } as Record<string, unknown>;
// The resource URI must be derived from the request origin here.
delete ENV.LUMIBASE_PUBLIC_URL;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

describe.skipIf(!hasDbIntegrationUrl)('MCP OAuth 2.1 — hosted MCP client against a real IdP (E2E)', () => {
  let db: Database;
  let cms: Server;
  let idp: Server;
  let provider: Provider;
  let issuer: string;
  let mcpUrl: URL;
  let resource: string;
  let createdBootstrap = false;

  /**
   * The user's browser: follows the authorization URL through the IdP's
   * login/consent interaction (auto-approved by the IdP's interaction handler
   * below) with a cookie jar, and returns the `code` from the redirect.
   */
  async function browse(authorizationUrl: URL, redirectUri: string): Promise<{ code: string; state: string | null }> {
    const jar = new Map<string, string>();
    let next = authorizationUrl.href;
    for (let hop = 0; hop < 12; hop += 1) {
      if (next.startsWith(redirectUri)) {
        const url = new URL(next);
        const error = url.searchParams.get('error');
        if (error) throw new Error(`authorization failed: ${error} ${url.searchParams.get('error_description') ?? ''}`);
        return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') };
      }
      const res = await fetch(next, {
        redirect: 'manual',
        headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      });
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const [name, ...value] = (pair ?? '').split('=');
        if (name) jar.set(name.trim(), value.join('='));
      }
      const location = res.headers.get('location');
      if (!location) throw new Error(`IdP stopped at ${res.status}: ${(await res.text()).slice(0, 300)}`);
      next = new URL(location, next).href;
    }
    throw new Error('too many redirects');
  }

  /** In-memory OAuthClientProvider, as a hosted client keeps per connection. */
  class TestOAuthProvider implements OAuthClientProvider {
    info?: OAuthClientInformationMixed;
    saved?: OAuthTokens;
    verifier?: string;
    lastAuthorizationUrl?: URL;
    constructor(readonly redirect: string) {}
    get redirectUrl() {
      return this.redirect;
    }
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'LumiBase MCP OAuth E2E',
        redirect_uris: [this.redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    }
    clientInformation() {
      return this.info;
    }
    saveClientInformation(info: OAuthClientInformationMixed) {
      this.info = info;
    }
    tokens() {
      return this.saved;
    }
    saveTokens(tokens: OAuthTokens) {
      this.saved = tokens;
    }
    redirectToAuthorization(url: URL) {
      this.lastAuthorizationUrl = url;
    }
    saveCodeVerifier(verifier: string) {
      this.verifier = verifier;
    }
    codeVerifier() {
      if (!this.verifier) throw new Error('no code verifier');
      return this.verifier;
    }
  }

  /**
   * Scopes the IdP's API resource grants. By default all four; a narrower list
   * models an IdP policy that only allows some of them for this client, and
   * the IdP silently drops the rest of the request. That is how a token ends
   * up narrower than what the client asked for.
   */
  const ALL_SCOPES = ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin'];
  let resourceScopes: string[] = ALL_SCOPES;

  /**
   * Full hosted-client connect: 401 → discovery → DCR → browser → token →
   * connect. The SDK chooses the requested scope itself (the MCP spec's rule:
   * the challenge's `scope`, else the metadata's `scopes_supported`).
   */
  async function connectHostedClient(grant?: string[]) {
    const oauth = new TestOAuthProvider('http://127.0.0.1:1/callback');
    const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauth });
    const client = new Client({ name: 'mcp-oauth-e2e', version: '1.0.0' });
    await expect(client.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(oauth.lastAuthorizationUrl).toBeDefined();
    resourceScopes = grant ?? ALL_SCOPES;
    const { code } = await browse(oauth.lastAuthorizationUrl!, oauth.redirect);
    await first.finishAuth(code);
    await client.close().catch(() => undefined);

    const connected = new Client({ name: 'mcp-oauth-e2e', version: '1.0.0' });
    await connected.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauth }));
    return { client: connected, oauth };
  }

  beforeAll(async () => {
    db = await connectDbIntegration('mcp-oauth-hosted-client');

    // ---- LumiBase over real HTTP ------------------------------------------
    cms = createAdaptorServer({ fetch: (req) => app.fetch(req, ENV) }) as Server;
    const cmsPort = await listen(cms);
    mcpUrl = new URL(`http://127.0.0.1:${cmsPort}/api/v1/mcp/sites/${SITE}`);
    resource = mcpUrl.href;

    // ---- The IdP ----------------------------------------------------------
    let interact: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
    let oidc: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
    idp = createServer((req, res) => {
      if (req.url?.startsWith('/interaction/') && interact) {
        interact(req, res).catch((error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        });
        return;
      }
      oidc?.(req, res);
    });
    issuer = `http://127.0.0.1:${await listen(idp)}`;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const signingKey = { ...privateKey.export({ format: 'jwk' }), kid: 'e2e-es256', alg: 'ES256', use: 'sig' };

    provider = new Provider(issuer, {
      jwks: { keys: [signingKey as never] },
      cookies: { keys: ['mcp-oauth-e2e-cookie-key'] },
      // The only signing key is ES256, so registered clients default to it.
      clientDefaults: { id_token_signed_response_alg: 'ES256' },
      scopes: ['openid', 'offline_access', 'mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin'],
      pkce: { required: () => true },
      features: {
        devInteractions: { enabled: false },
        registration: { enabled: true },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => undefined,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx: KoaContextWithOIDC, indicator: string) => ({
            scope: resourceScopes.join(' '),
            audience: indicator,
            accessTokenTTL: 300,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256' } },
          }),
        },
      },
      // What LumiBase's issuer config maps: email + role claim.
      extraTokenClaims: () => ({ email: ACCOUNT_EMAIL, roles: ['editor'] }),
      findAccount: (_ctx: KoaContextWithOIDC, sub: string) => ({
        accountId: sub,
        claims: () => ({ sub, email: ACCOUNT_EMAIL }),
      }),
      interactions: { url: (_ctx: KoaContextWithOIDC, interaction: { uid: string }) => `/interaction/${interaction.uid}` },
      ttl: { RefreshToken: 3600 },
      // Common IdP policy for public clients: a refresh token whenever the
      // client registered the refresh_token grant (no offline_access needed).
      issueRefreshToken: (_ctx: KoaContextWithOIDC, client: { grantTypeAllowed: (type: string) => boolean }) =>
        client.grantTypeAllowed('refresh_token'),
    });
    oidc = provider.callback() as never;

    // The "user": logs in as ACCOUNT and approves whatever the client asked for.
    interact = async (req, res) => {
      const details = await provider.interactionDetails(req, res);
      const { prompt, params, grantId } = details;
      const accountId = details.session?.accountId ?? ACCOUNT;
      if (prompt.name === 'login') {
        await provider.interactionFinished(req, res, { login: { accountId } }, { mergeWithLastSubmission: false });
        return;
      }
      const grant = grantId
        ? (await provider.Grant.find(grantId))!
        : new provider.Grant({ accountId, clientId: String(params.client_id) });
      const missing = prompt.details as {
        missingOIDCScope?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
        grant.addResourceScope(indicator, scopes.join(' '));
      }
      const saved = await grant.save();
      await provider.interactionFinished(req, res, { consent: { grantId: saved } }, { mergeWithLastSubmission: true });
    };

    // ---- LumiBase fixture -------------------------------------------------
    await cleanup();
    const [bootstrap] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    if (!bootstrap) {
      await db.insert(users).values({ id: BOOTSTRAP_USER, email: 'mcp-oauth-e2e-bootstrap@example.test', status: 'active', isBootstrap: true });
      createdBootstrap = true;
    }
    await db.insert(organizations).values({ id: ORG, slug: ORG, name: 'MCP OAuth E2E' });
    await provisionSite(db, { id: SITE, name: 'MCP OAuth E2E', organizationId: ORG });
    await db.insert(settings).values({ siteId: SITE, key: 'contentOs', value: { mcp: true } });
    // Inserted directly: the admin API only accepts http:// issuers on
    // localhost in development, which is exactly this setup.
    await db.insert(authExternalIssuers).values({
      siteId: SITE,
      issuer,
      jwksUri: `${issuer}/jwks`,
      discoveryUrl: null,
      audience: [resource],
      algorithms: ['ES256'],
      claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
      roleMapping: { editor: { systemKey: 'administrator' } },
      defaultRoleId: null,
      jitProvisioning: true,
      clockSkewSeconds: 30,
      enabled: true,
    });
  }, 60_000);

  async function cleanup() {
    if (!db) return;
    await db.delete(authExternalIssuers).where(eq(authExternalIssuers.siteId, SITE)).catch(() => undefined);
    await db.delete(settings).where(and(eq(settings.siteId, SITE), eq(settings.key, 'contentOs'))).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(organizations).where(eq(organizations.id, ORG)).catch(() => undefined);
    await db.delete(users).where(eq(users.externalId, ACCOUNT)).catch(() => undefined);
    if (createdBootstrap) await db.delete(users).where(inArray(users.id, [BOOTSTRAP_USER])).catch(() => undefined);
  }

  afterAll(async () => {
    await cleanup();
    await close(cms);
    await close(idp);
  });

  it('answers an unauthenticated MCP call with the RFC 9728 challenge and metadata', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
    const metadataUrl = `http://${mcpUrl.host}/.well-known/oauth-protected-resource/api/v1/mcp/sites/${SITE}`;
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${metadataUrl}"`);

    const metadata = await (await fetch(metadataUrl)).json();
    expect(metadata).toMatchObject({ resource, authorization_servers: [issuer], bearer_methods_supported: ['header'] });
    // The client can reach the AS from there.
    expect((await discoverAuthorizationServerMetadata(issuer))?.issuer).toBe(issuer);
  });

  it('connects the MCP SDK client end to end: discovery, DCR, PKCE + resource, token, tools', async () => {
    const { client, oauth } = await connectHostedClient();
    try {
      // Dynamic Client Registration happened against the real IdP.
      expect(oauth.info?.client_id).toBeTruthy();
      // The authorization request carried PKCE S256 and the MCP resource.
      const auth = oauth.lastAuthorizationUrl!;
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(auth.searchParams.get('code_challenge')).toBeTruthy();
      expect(auth.searchParams.get('resource')).toBe(resource);
      // With no scope in the challenge, the client asks for scopes_supported.
      expect(auth.searchParams.get('scope')?.split(' ').sort()).toEqual(['mcp:admin', 'mcp:delete', 'mcp:read', 'mcp:write']);

      // The issued access token is a JWT for exactly this resource.
      const [, body] = oauth.saved!.access_token.split('.');
      const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
      expect(claims).toMatchObject({ iss: issuer, aud: resource, sub: ACCOUNT });
      expect(String(claims.scope).split(' ').sort()).toEqual(['mcp:admin', 'mcp:delete', 'mcp:read', 'mcp:write']);

      const { tools } = await client.listTools();
      const listCollections = tools.find((tool) => tool.name === 'listCollections');
      expect(listCollections).toBeDefined();
      expect(listCollections?.annotations).toMatchObject({ readOnlyHint: true });
      expect(tools.find((tool) => tool.name === 'deleteCollection')?.annotations).toMatchObject({ destructiveHint: true });

      const result = await client.callTool({ name: 'listCollections', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'executed' });

      // JIT provisioning mapped the IdP user onto this site.
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, ACCOUNT)).limit(1);
      expect(user).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('narrows by scope: a control-plane tool without mcp:admin gets a 403 step-up challenge', async () => {
    // The IdP grants only mcp:read, although the user holds an admin role.
    const { client, oauth } = await connectHostedClient(['mcp:read']);
    const [, body] = oauth.saved!.access_token.split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString()).scope).toBe('mcp:read');
    // A read still works through the SDK.
    const read = await client.callTool({ name: 'listCollections', arguments: {} });
    expect(read.structuredContent).toMatchObject({ status: 'executed' });
    await client.close();
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${oauth.saved!.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deleteCollection', arguments: { name: 'nope' } } }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(res.headers.get('www-authenticate')).toContain('scope="mcp:admin"');
  });

  it('rejects tokens by audience in both directions', async () => {
    const { client, oauth } = await connectHostedClient(['mcp:read']);
    await client.close();
    const mcpToken = oauth.saved!.access_token;

    // The MCP token replayed against REST: refused.
    const rest = await fetch(`http://${mcpUrl.host}/api/v1/items/anything`, {
      headers: { authorization: `Bearer ${mcpToken}`, 'x-lumi-site': SITE },
    });
    expect(rest.status).toBe(401);

    // A token from the same trusted IdP, minted for another resource: refused on MCP.
    const metadata = (await discoverAuthorizationServerMetadata(issuer))!;
    const redirect = oauth.redirect;
    const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
      metadata,
      clientInformation: oauth.info!,
      redirectUrl: redirect,
      scope: 'mcp:read',
      resource: new URL(OTHER_RESOURCE),
    });
    const { code } = await browse(authorizationUrl, redirect);
    const other = await exchangeAuthorization(issuer, {
      metadata,
      clientInformation: oauth.info!,
      authorizationCode: code,
      codeVerifier,
      redirectUri: redirect,
      resource: new URL(OTHER_RESOURCE),
    });
    const [, body] = other.access_token.split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString()).aud).toBe(OTHER_RESOURCE);

    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('refreshes the access token and keeps working', async () => {
    const { client, oauth } = await connectHostedClient(['mcp:read']);
    await client.close();
    expect(oauth.saved?.refresh_token).toBeTruthy();

    const metadata = (await discoverAuthorizationServerMetadata(issuer))!;
    const refreshed = await refreshAuthorization(issuer, {
      metadata,
      clientInformation: oauth.info!,
      refreshToken: oauth.saved!.refresh_token!,
      resource: new URL(resource),
    });
    expect(refreshed.access_token).not.toBe(oauth.saved!.access_token);
    oauth.saveTokens(refreshed);

    const again = new Client({ name: 'mcp-oauth-e2e', version: '1.0.0' });
    await again.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauth }));
    try {
      const result = await again.callTool({ name: 'listCollections', arguments: {} });
      expect(result.structuredContent).toMatchObject({ status: 'executed' });
    } finally {
      await again.close();
    }
  });
});
