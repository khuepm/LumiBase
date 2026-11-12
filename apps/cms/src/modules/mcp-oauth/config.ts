/**
 * mcp-oauth/config.ts — operator configuration for OAuth 2.1 access tokens on
 * the remote MCP endpoint (#346).
 *
 * LumiBase is the *protected resource* only. It never issues these tokens: an
 * external authorization server does, and the operator names it here. With any
 * of the three required values missing the feature is off and the MCP route
 * behaves exactly as before.
 */

export type McpOAuthSubject = 'user_id' | 'external_id';

export interface McpOAuthConfig {
  /** `iss` every accepted token must carry; also advertised as the authorization server. */
  issuer: string;
  /** Where the authorization server publishes its signing keys. */
  jwksUri: string;
  /** Canonical URL of this MCP endpoint. Tokens must name it in `aud` (RFC 8707). */
  resource: string;
  /** Which `users` column the token's `sub` identifies. */
  subject: McpOAuthSubject;
}

export interface McpOAuthEnv {
  MCP_OAUTH_ISSUER?: string;
  MCP_OAUTH_JWKS_URI?: string;
  MCP_OAUTH_RESOURCE?: string;
  MCP_OAUTH_SUBJECT?: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    // Plain http is only ever a local development server.
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * Read the config from the Worker bindings, falling back to `process.env` for
 * the Node.js / Docker entry (where `c.env` is not populated). Returns `null`
 * unless issuer, JWKS URI and resource are all present and well-formed — a
 * half-configured deployment stays closed rather than guessing.
 */
export function readMcpOAuthConfig(env: McpOAuthEnv | undefined): McpOAuthConfig | null {
  const read = (key: keyof McpOAuthEnv): string =>
    (env?.[key] ?? (typeof process !== 'undefined' ? process.env[key] : undefined) ?? '').trim();
  const issuer = read('MCP_OAUTH_ISSUER');
  const jwksUri = read('MCP_OAUTH_JWKS_URI');
  const resource = read('MCP_OAUTH_RESOURCE');
  if (!issuer || !jwksUri || !resource) return null;
  if (!isHttpUrl(issuer) || !isHttpUrl(jwksUri) || !isHttpUrl(resource)) return null;
  return {
    issuer,
    jwksUri,
    resource,
    subject: read('MCP_OAUTH_SUBJECT') === 'external_id' ? 'external_id' : 'user_id',
  };
}
