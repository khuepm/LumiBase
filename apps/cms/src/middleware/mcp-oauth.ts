import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import {
  bearerChallenge,
  canonicalMcpPath,
  mcpResourceUri,
  protectedResourceMetadataUrl,
  publicBaseUrl,
} from '../services/mcp-oauth';

/** Resource identity of the MCP endpoint this request targets. */
export interface McpResourceContext {
  /** Canonical MCP path (`/api/v1/mcp` or `/api/v1/mcp/sites/<id>`). */
  mcpPath: string;
  /** RFC 8707 resource URI — what an OAuth token's `aud` must contain. */
  resource: string;
  /** RFC 9728 metadata URL advertised in `WWW-Authenticate`. */
  resourceMetadata: string;
}

/**
 * The MCP resource a request path addresses, or `null` when the path is not an
 * MCP endpoint. `mcpPath` overrides the request path (used by the metadata
 * route, whose own path is the well-known one).
 */
export function mcpResourceContext(c: Context<AppEnv>, mcpPath?: string | null): McpResourceContext | null {
  const path = mcpPath === undefined ? canonicalMcpPath(c.req.path) : mcpPath;
  if (!path) return null;
  const base = publicBaseUrl({
    url: c.req.url,
    env: c.env as { LUMIBASE_PUBLIC_URL?: string } | undefined,
    forwardedProto: c.req.header('x-forwarded-proto'),
  });
  return {
    mcpPath: path,
    resource: mcpResourceUri(base, path),
    resourceMetadata: protectedResourceMetadataUrl(base, path),
  };
}

/**
 * Adds the RFC 9728 discovery challenge to every 401 the MCP endpoint returns
 * (MCP authorization spec: "MUST use the HTTP header WWW-Authenticate when
 * returning a 401"). Mounted on the MCP paths BEFORE the authenticated chain so
 * it wraps the 401s `withAuth` produces, not only the route's own.
 *
 * The header is static (no DB read), so it is safe on the unauthenticated path:
 * it reveals nothing but a URL derived from the request itself. Whether that
 * metadata document actually lists an authorization server is decided by the
 * metadata route.
 */
export const withMcpAuthChallenge = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  if (c.res.status !== 401 || c.res.headers.has('www-authenticate')) return;
  const ctx = mcpResourceContext(c);
  if (!ctx) return;
  c.res.headers.set('WWW-Authenticate', bearerChallenge({ resourceMetadata: ctx.resourceMetadata }));
};
