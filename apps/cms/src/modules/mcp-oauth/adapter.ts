/**
 * mcp-oauth/adapter.ts — wires {@link verifyMcpAccessToken} to the request:
 * config, JWKS, and the lookup of the LumiBase user the token speaks for.
 *
 * The token only *identifies* an existing user. Site membership is still
 * decided by `withSiteMembership`, and capabilities by the user's live RBAC
 * bundle, so an OAuth client can never do more than that user could in Studio.
 */

import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet } from 'jose';
import { users } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { isMcpPath } from '../../services/organization-access';
import { readMcpOAuthConfig } from './config';
import { verifyMcpAccessToken } from './verifier';

const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(url: string) {
  let jwks = JWKS_CACHE.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    JWKS_CACHE.set(url, jwks);
  }
  return jwks;
}

export type McpOAuthAttempt =
  | { kind: 'skip' }
  | { kind: 'rejected'; status: 401 | 403; code: string }
  | { kind: 'authenticated'; principal: AuthPrincipal };

/** Scopes of an OAuth principal, or `null` when the request used another credential. */
export function mcpOAuthScopes(auth: AuthPrincipal | undefined): string[] | null {
  const raw = auth?.raw;
  if (raw?.['mcpOAuth'] !== true) return null;
  const scopes = raw['scopes'];
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [];
}

export async function tryMcpOAuth(c: Context<AppEnv>, token: string): Promise<McpOAuthAttempt> {
  // Accepted on the MCP route only: the same bearer is not a session anywhere else.
  if (!isMcpPath(c.req.path)) return { kind: 'skip' };
  const config = readMcpOAuthConfig(c.env);
  if (!config) return { kind: 'skip' };

  const outcome = await verifyMcpAccessToken(token, {
    config,
    jwks: getJwks(config.jwksUri),
    requestSiteId: c.get('siteId'),
  });
  if (outcome.kind !== 'verified') return outcome;

  const { subject, scopes, tokenVersion } = outcome.token;
  const [user] = await c
    .get('db')
    .select({ id: users.id, email: users.email, status: users.status, tokenVersion: users.tokenVersion })
    .from(users)
    .where(config.subject === 'external_id' ? eq(users.externalId, subject) : eq(users.id, subject))
    .limit(1);
  if (!user || user.status !== 'active') return { kind: 'rejected', status: 401, code: 'USER_NOT_FOUND' };
  // When the authorization server pins the user's token version, a password
  // change or reset revokes the grant the same way it revokes a session.
  if (tokenVersion !== undefined && tokenVersion !== (user.tokenVersion ?? 0)) {
    return { kind: 'rejected', status: 401, code: 'TOKEN_REVOKED' };
  }

  return {
    kind: 'authenticated',
    principal: {
      type: 'user',
      userId: user.id,
      email: user.email,
      roles: [],
      // Built field by field, never spread from the token: `raw` is read by
      // guards elsewhere (`dev`, `aud`, `isBootstrap`), and a claim must not be
      // able to set any of them.
      raw: { mcpOAuth: true, iss: config.issuer, scopes },
    },
  };
}
