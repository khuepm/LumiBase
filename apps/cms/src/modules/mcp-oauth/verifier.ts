/**
 * mcp-oauth/verifier.ts — verify an OAuth 2.1 access token presented to the
 * remote MCP endpoint (#346). Pure: the key source is injected, so it tests
 * with real keys and no network.
 *
 * Contract, mirroring `external-auth/verifier.ts`:
 *  - `skip` only while the token is not addressed to the configured issuer, so
 *    API keys and session tokens keep reaching their own branches;
 *  - once `iss` matches, every failure is a fail-closed `rejected`.
 */

import { decodeJwt, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { McpOAuthConfig } from './config';
import { parseScopes } from './scopes';

/** Asymmetric only. `none` and HS* can never verify against a public JWKS. */
const ALLOWED_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const MAX_TOKEN_CHARS = 8192;

export interface VerifiedMcpToken {
  subject: string;
  scopes: string[];
  email?: string;
  /** `token_version` claim, when the authorization server binds one. */
  tokenVersion?: number;
}

export type McpTokenOutcome =
  | { kind: 'skip' }
  | { kind: 'rejected'; status: 401 | 403; code: string }
  | { kind: 'verified'; token: VerifiedMcpToken };

export interface McpTokenVerifierDeps {
  config: McpOAuthConfig;
  jwks: JWTVerifyGetKey | CryptoKey | Uint8Array;
  requestSiteId: string | undefined;
}

export async function verifyMcpAccessToken(token: string, deps: McpTokenVerifierDeps): Promise<McpTokenOutcome> {
  if (token.length > MAX_TOKEN_CHARS) return { kind: 'skip' };

  let issuer: unknown;
  let alg: string;
  try {
    issuer = decodeJwt(token).iss;
    alg = decodeProtectedHeader(token).alg ?? '';
  } catch {
    return { kind: 'skip' };
  }
  if (issuer !== deps.config.issuer) return { kind: 'skip' };

  if (!ALLOWED_ALGORITHMS.includes(alg)) return { kind: 'rejected', status: 401, code: 'ALG_NOT_ALLOWED' };

  let payload;
  try {
    ({ payload } = await jwtVerify(token, deps.jwks as JWTVerifyGetKey, {
      issuer: deps.config.issuer,
      // Audience binding is what stops a token minted for another resource of
      // the same authorization server from being passed through to this one.
      audience: deps.config.resource,
      algorithms: ALLOWED_ALGORITHMS,
      requiredClaims: ['sub', 'exp', 'aud'],
    }));
  } catch {
    return { kind: 'rejected', status: 401, code: 'TOKEN_INVALID' };
  }

  // A token bound to one site may not be replayed against another the same
  // user happens to belong to.
  const claimSite = payload['site_id'];
  if (claimSite !== undefined && claimSite !== deps.requestSiteId) {
    return { kind: 'rejected', status: 403, code: 'SITE_MISMATCH' };
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (!subject) return { kind: 'rejected', status: 401, code: 'TOKEN_INVALID' };

  const tokenVersion = payload['token_version'];
  return {
    kind: 'verified',
    token: {
      subject,
      scopes: parseScopes(payload['scope'], payload['scp']),
      email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
      tokenVersion: typeof tokenVersion === 'number' ? tokenVersion : undefined,
    },
  };
}
