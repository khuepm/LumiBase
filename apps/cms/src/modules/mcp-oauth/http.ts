/**
 * mcp-oauth/http.ts — the two HTTP pieces an MCP client needs to discover how
 * to authorize (#346): the metadata document and the 401 challenge.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../env';
import { readMcpOAuthConfig } from './config';
import { bearerChallenge, protectedResourceMetadata, protectedResourceMetadataUrl } from './metadata';

/** `GET /.well-known/oauth-protected-resource[/api/v1/mcp]` — public by design. */
export const protectedResourceMetadataHandler = (c: Context<AppEnv>) => {
  const config = readMcpOAuthConfig(c.env);
  const requested = new URL(c.req.url).pathname.replace(/\/$/, '');
  const root = '/.well-known/oauth-protected-resource';
  // Answer at the root and at the one path that names this resource; any other
  // suffix describes a resource this server does not have.
  if (!config || (requested !== root && requested !== new URL(protectedResourceMetadataUrl(config)).pathname)) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404);
  }
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(protectedResourceMetadata(config));
};

/** Adds `WWW-Authenticate` to any 401 the MCP route returns. */
export const withMcpOAuthChallenge = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  if (c.res.status !== 401) return;
  const config = readMcpOAuthConfig(c.env);
  if (config) c.res.headers.set('WWW-Authenticate', bearerChallenge(config));
};
