/**
 * mcp-oauth/metadata.ts — OAuth 2.0 Protected Resource Metadata (RFC 9728) for
 * the MCP endpoint, and the `WWW-Authenticate` challenge that points at it.
 */

import type { McpOAuthConfig } from './config';
import { MCP_SCOPES_SUPPORTED } from './scopes';

/** RFC 9728 §3.1: the well-known segment is inserted before the resource path. */
export function protectedResourceMetadataUrl(config: McpOAuthConfig): string {
  const resource = new URL(config.resource);
  const path = resource.pathname === '/' ? '' : resource.pathname.replace(/\/$/, '');
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata(config: McpOAuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: MCP_SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
  };
}

export function bearerChallenge(config: McpOAuthConfig): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`;
}
