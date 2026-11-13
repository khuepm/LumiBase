/**
 * mcp-oauth.ts — OAuth 2.1 protected-resource helpers for the remote MCP
 * endpoint (#346).
 *
 * LumiBase is the *resource server* only. Authorization is delegated to a
 * site's trusted external issuer (`lumibase_auth_external_issuers`, the same
 * table `withAuth` already verifies against), so no IdP lives in-tree:
 *
 *   1. A client hits `POST /api/v1/mcp` with no token → 401 carrying
 *      `WWW-Authenticate: Bearer resource_metadata="…"` (MCP auth spec §2.3.1).
 *   2. It fetches the RFC 9728 Protected Resource Metadata, which names the
 *      authorization server(s) — every enabled issuer whose configured
 *      `audience` includes this MCP resource URI.
 *   3. It runs authorization-code + PKCE against that issuer with RFC 8707
 *      `resource=<MCP resource URI>` and comes back with a token whose `aud`
 *      is the resource.
 *
 * The audience wall (ADR-011 style) is enforced both ways in
 * `external-auth/adapter.ts`: on the MCP path an external token MUST carry the
 * exact resource URI in `aud` (no pass-through of tokens minted for something
 * else), and a token minted only for an MCP resource is refused everywhere
 * else (no replay of an MCP connector token against REST).
 *
 * Scopes only ever NARROW: capabilities still come from the token's live RBAC
 * bundle (#472), and {@link narrowCapabilitiesByScopes} intersects that with
 * what the granted scopes allow.
 *
 * Everything here is pure (no DB, no Hono context beyond header reads) so it
 * unit-tests directly.
 */

import { UNLIMITED_CAPABILITY_TOKENS } from './effective-capability-service';

/** Base path of the MCP endpoint (resource identified by the request host). */
export const MCP_BASE_PATH = '/api/v1/mcp';

/** RFC 9728 well-known prefix. The resource path is appended to it. */
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * Site-addressed MCP endpoint: `/api/v1/mcp/sites/<siteId>`. Needed because a
 * hosted connector (Claude, ChatGPT, IDE remote MCP) only knows a URL — it
 * cannot send `X-Lumi-Site`. Hosts mapped to a site (custom domain / free
 * subdomain) can keep using the bare base path.
 */
const MCP_SITE_PATH = /^\/api\/v1\/mcp\/sites\/([^/]+)\/?$/;
const MCP_BASE_PATH_RE = /^\/api\/v1\/mcp\/?$/;

/** OAuth scopes understood by the MCP resource. */
export const MCP_SCOPES = {
  /** Capabilities whose action is `read`. */
  read: 'mcp:read',
  /** Capabilities that create, update, run or manage. */
  write: 'mcp:write',
  /** Capabilities whose action is `delete`. */
  delete: 'mcp:delete',
  /**
   * Control-plane skills (dangerous / schema-mutating / `delete*`) and agent
   * approval decisions. Still additionally requires an admin principal — the
   * `CONTROL_PLANE_FORBIDDEN` backstop is unchanged.
   */
  admin: 'mcp:admin',
} as const;

export type McpScope = (typeof MCP_SCOPES)[keyof typeof MCP_SCOPES];

export const MCP_SCOPES_SUPPORTED: readonly McpScope[] = [
  MCP_SCOPES.read,
  MCP_SCOPES.write,
  MCP_SCOPES.delete,
  MCP_SCOPES.admin,
];

/** Capabilities that are gated by `mcp:admin` rather than by their verb. */
const ADMIN_SCOPED_CAPABILITIES = new Set(['ai:decide']);

/**
 * Canonical MCP path for a request path, or `null` when the path is not an MCP
 * endpoint. Strips a trailing slash so `/api/v1/mcp/` and `/api/v1/mcp` name
 * the same resource.
 */
export function canonicalMcpPath(path: string): string | null {
  if (MCP_BASE_PATH_RE.test(path)) return MCP_BASE_PATH;
  const site = MCP_SITE_PATH.exec(path);
  if (site?.[1]) return `${MCP_BASE_PATH}/sites/${site[1]}`;
  return null;
}

/**
 * Site id addressed by the path, for either the MCP endpoint itself or its
 * protected-resource metadata document. `null` when the path does not carry one;
 * `''` when it does but the segment is not decodable (callers reject it).
 */
export function mcpSiteIdFromPath(path: string): string | null {
  const resourcePath = path.startsWith(PROTECTED_RESOURCE_METADATA_PATH)
    ? path.slice(PROTECTED_RESOURCE_METADATA_PATH.length)
    : path;
  const site = MCP_SITE_PATH.exec(resourcePath);
  return site?.[1] ? (decodeURIComponentSafe(site[1]) ?? '') : null;
}

/**
 * MCP resource path described by a metadata request path. The bare well-known
 * document (no suffix) describes the base endpoint. `null` for anything else.
 */
export function mcpPathFromMetadataPath(path: string): string | null {
  if (!path.startsWith(PROTECTED_RESOURCE_METADATA_PATH)) return null;
  const suffix = path.slice(PROTECTED_RESOURCE_METADATA_PATH.length);
  if (suffix === '' || suffix === '/') return MCP_BASE_PATH;
  return canonicalMcpPath(suffix);
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

interface PublicUrlSource {
  url: string;
  env?: { LUMIBASE_PUBLIC_URL?: string } | undefined;
  forwardedProto?: string | undefined;
}

/**
 * Public origin used to build resource URIs. `LUMIBASE_PUBLIC_URL` wins (set it
 * behind a TLS-terminating proxy); otherwise the request origin, upgraded to
 * `https` when the proxy says so. The host is never taken from anything but the
 * request itself, and a forged host cannot help an attacker: the token's `aud`
 * must still match an audience the trusted issuer is configured for.
 */
export function publicBaseUrl(source: PublicUrlSource): string {
  const explicit = source.env?.LUMIBASE_PUBLIC_URL ?? process.env.LUMIBASE_PUBLIC_URL;
  if (explicit) return explicit.trim().replace(/\/+$/, '');
  try {
    const url = new URL(source.url);
    if (source.forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https') url.protocol = 'https:';
    return url.origin;
  } catch {
    return '';
  }
}

/** The RFC 8707 resource identifier for an MCP path. */
export function mcpResourceUri(baseUrl: string, mcpPath: string): string {
  return `${baseUrl}${mcpPath}`;
}

/** The RFC 9728 metadata URL for an MCP path. */
export function protectedResourceMetadataUrl(baseUrl: string, mcpPath: string): string {
  return `${baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}${mcpPath}`;
}

/**
 * True when an `aud` value names *an* MCP resource — on any origin. Used for
 * the reverse wall: a token minted only for MCP is refused on REST paths, even
 * if `LUMIBASE_PUBLIC_URL` and the issuer disagree on the origin.
 */
export function isMcpResourceUri(value: string): boolean {
  try {
    return canonicalMcpPath(new URL(value).pathname) !== null;
  } catch {
    return false;
  }
}

/**
 * Scopes granted by a verified token: the space-delimited `scope` claim
 * (RFC 9068 / RFC 8693) or the `scp` claim some issuers emit instead, as a
 * string or array. Unknown scopes are kept — they simply match nothing.
 */
export function scopesFromClaims(payload: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const claim of [payload.scope, payload.scp]) {
    if (typeof claim === 'string') {
      for (const s of claim.split(/\s+/)) if (s) out.add(s);
    } else if (Array.isArray(claim)) {
      for (const s of claim) if (typeof s === 'string' && s) out.add(s);
    }
  }
  return [...out];
}

/** The MCP scope that unlocks a capability string (`items:write` → `mcp:write`). */
export function scopeForCapability(capability: string): McpScope {
  if (ADMIN_SCOPED_CAPABILITIES.has(capability)) return MCP_SCOPES.admin;
  const action = capability.split(':')[1] ?? '';
  if (action === 'read') return MCP_SCOPES.read;
  if (action === 'delete') return MCP_SCOPES.delete;
  return MCP_SCOPES.write;
}

/** Minimal set of MCP scopes needed for a list of capabilities. */
export function scopesForCapabilities(capabilities: readonly string[]): McpScope[] {
  const needed = new Set(capabilities.map(scopeForCapability));
  return MCP_SCOPES_SUPPORTED.filter((s) => needed.has(s));
}

/**
 * Intersect an RBAC-derived capability set with what the token's scopes allow.
 *
 * Never widens: the result is always a subset of `capabilities` (or of
 * `universe` when `capabilities` holds an unlimited marker, which is the only
 * way to express "admin, minus the parts this token was not scoped for").
 *
 * - A capability survives when the token carries its verb scope
 *   (`mcp:read`/`mcp:write`/`mcp:delete`/`mcp:admin`) or the exact capability
 *   string as a scope (`items:read`), for issuers that model fine-grained scopes.
 * - An unlimited marker (`admin`, `*`) survives only when ALL four MCP scopes
 *   were granted; otherwise it is expanded to `universe` and filtered.
 * - No recognised scope ⇒ no capabilities (discovery still works).
 */
export function narrowCapabilitiesByScopes(
  capabilities: readonly string[],
  scopes: readonly string[],
  universe: readonly string[],
): string[] {
  const granted = new Set(scopes);
  const unlimited = capabilities.some((cap) => UNLIMITED_CAPABILITY_TOKENS.includes(cap));
  if (unlimited && MCP_SCOPES_SUPPORTED.every((s) => granted.has(s))) {
    return [...capabilities];
  }
  const base = unlimited
    ? [...new Set([...universe, ...capabilities.filter((cap) => !UNLIMITED_CAPABILITY_TOKENS.includes(cap))])]
    : [...capabilities];
  return base
    .filter((cap) => !UNLIMITED_CAPABILITY_TOKENS.includes(cap))
    .filter((cap) => granted.has(cap) || granted.has(scopeForCapability(cap)))
    .sort();
}

/** Quote a value for an RFC 6750 auth-param (escape `\` and `"`). */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * `WWW-Authenticate` value for the MCP endpoint (RFC 6750 §3 + RFC 9728 §5.1).
 * Without `error` it is the plain discovery challenge sent on every 401.
 */
export function bearerChallenge(opts: {
  resourceMetadata: string;
  error?: 'invalid_token' | 'insufficient_scope';
  scope?: readonly string[];
  description?: string;
}): string {
  const params: string[] = [];
  if (opts.error) params.push(`error=${quote(opts.error)}`);
  if (opts.description) params.push(`error_description=${quote(opts.description)}`);
  if (opts.scope && opts.scope.length > 0) params.push(`scope=${quote(opts.scope.join(' '))}`);
  params.push(`resource_metadata=${quote(opts.resourceMetadata)}`);
  return `Bearer ${params.join(', ')}`;
}

/** An issuer row's configured audience(s), normalised to a list. */
export function issuerAudiences(audience: unknown): string[] {
  if (typeof audience === 'string') return [audience];
  if (Array.isArray(audience)) return audience.filter((a): a is string => typeof a === 'string');
  return [];
}

/**
 * Issuers that act as authorization servers for `resource`: enabled issuers
 * whose configured audience includes the exact resource URI. Opting in is
 * therefore one admin action — add the MCP resource URI to the issuer's
 * audience — with no new config surface.
 */
export function authorizationServersFor(
  issuers: ReadonlyArray<{ issuer: string; audience: unknown; enabled?: boolean | null }>,
  resource: string,
): string[] {
  const out = new Set<string>();
  for (const row of issuers) {
    if (row.enabled === false) continue;
    if (issuerAudiences(row.audience).includes(resource)) out.add(row.issuer);
  }
  return [...out].sort();
}

/** RFC 9728 §2 Protected Resource Metadata document. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation?: string;
}

export function buildProtectedResourceMetadata(input: {
  resource: string;
  authorizationServers: string[];
  documentationUrl?: string;
}): ProtectedResourceMetadata {
  return {
    resource: input.resource,
    authorization_servers: input.authorizationServers,
    scopes_supported: [...MCP_SCOPES_SUPPORTED],
    // RFC 6750 §2.2/2.3 (body / query) are deliberately not offered: tokens in
    // URLs end up in logs, and the MCP spec requires the header form.
    bearer_methods_supported: ['header'],
    resource_name: 'LumiBase MCP',
    ...(input.documentationUrl ? { resource_documentation: input.documentationUrl } : {}),
  };
}
