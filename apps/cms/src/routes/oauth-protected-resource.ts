import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { authExternalIssuers, scopeSite } from '@lumibase/database';
import type { AppEnv } from '../env';
import { mcpResourceContext } from '../middleware/mcp-oauth';
import { getContentOsFlags } from '../services/feature-flags';
import {
  authorizationServersFor,
  buildProtectedResourceMetadata,
  mcpPathFromMetadataPath,
} from '../services/mcp-oauth';

/**
 * RFC 9728 Protected Resource Metadata for the remote MCP endpoint (#346).
 *
 * Mounted at `/.well-known/oauth-protected-resource` with the tenant chain
 * (`withTenant` → `withDb` → `withTenantExists`) but WITHOUT auth: discovery
 * happens before the client has a token. Three shapes are served:
 *
 *   /.well-known/oauth-protected-resource                        → base endpoint
 *   /.well-known/oauth-protected-resource/api/v1/mcp             → base endpoint
 *   /.well-known/oauth-protected-resource/api/v1/mcp/sites/<id>  → site endpoint
 *
 * The base form resolves the site from the host mapping (or `X-Lumi-Site`); the
 * site form carries it in the path, for hosts that serve more than one site.
 *
 * 404 unless the site has the `contentOs.mcp` flag on AND at least one enabled
 * trusted issuer lists this exact resource URI in its audience. Without an
 * authorization server the document would only send clients down a dead end.
 */
export const protectedResourceRouter = new Hono<AppEnv>();

async function serveMetadata(c: Context<AppEnv>) {
  const notFound = () =>
    c.json({ errors: [{ code: 'NOT_FOUND', message: 'No OAuth-protected MCP resource here.' }] }, 404);

  const mcpPath = mcpPathFromMetadataPath(c.req.path);
  const siteId = c.get('siteId');
  const db = c.get('db');
  if (!mcpPath || !siteId || !db) return notFound();

  const flags = await getContentOsFlags(db, siteId);
  if (!flags.mcp) return notFound();

  const ctx = mcpResourceContext(c, mcpPath);
  if (!ctx) return notFound();

  const issuers = await db
    .select({ issuer: authExternalIssuers.issuer, audience: authExternalIssuers.audience, enabled: authExternalIssuers.enabled })
    .from(authExternalIssuers)
    .where(and(scopeSite(authExternalIssuers.siteId, siteId), eq(authExternalIssuers.enabled, true)));
  const authorizationServers = authorizationServersFor(issuers, ctx.resource);
  if (authorizationServers.length === 0) return notFound();

  c.header('Cache-Control', 'public, max-age=300');
  // Public, credential-free document: browser-based MCP clients must be able
  // to read it cross-origin.
  c.header('Access-Control-Allow-Origin', '*');
  return c.json(
    buildProtectedResourceMetadata({
      resource: ctx.resource,
      authorizationServers,
      documentationUrl: 'https://github.com/khuepm/LumiBase/blob/main/docs/en/agent-setup/oauth-connector.md',
    }),
  );
}

protectedResourceRouter.get('/', serveMetadata);
protectedResourceRouter.get('/api/v1/mcp', serveMetadata);
protectedResourceRouter.get('/api/v1/mcp/sites/:siteId', serveMetadata);
