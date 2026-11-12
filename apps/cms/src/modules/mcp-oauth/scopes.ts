/**
 * mcp-oauth/scopes.ts — OAuth scopes as a *ceiling* on harness capabilities.
 *
 * A scope can only remove capabilities the user's live RBAC bundle already
 * grants; it never adds one. So a token is bounded twice: by what the user may
 * do, and by what the user consented to hand the client.
 */

import { UNLIMITED_CAPABILITY_TOKENS } from '../../services/effective-capability-service';

export const MCP_SCOPE = {
  /** Read tools only. */
  read: 'lumibase.read',
  /** Plus content writes: items and translations. */
  write: 'lumibase.write',
  /** Plus everything else the user holds, including control-plane skills. */
  admin: 'lumibase.admin',
} as const;

export const MCP_SCOPES_SUPPORTED: readonly string[] = [MCP_SCOPE.read, MCP_SCOPE.write, MCP_SCOPE.admin];

/** Capability namespaces the `lumibase.write` scope opens for writing. */
const CONTENT_NAMESPACES = new Set(['items', 'translations']);

/** Parse the `scope` (space-delimited string) or `scp` (array) claim. */
export function parseScopes(scope: unknown, scp?: unknown): string[] {
  const out = new Set<string>();
  if (typeof scope === 'string') for (const s of scope.split(/\s+/)) if (s) out.add(s);
  if (Array.isArray(scp)) for (const s of scp) if (typeof s === 'string' && s) out.add(s);
  return [...out];
}

/**
 * Keep only the capabilities the granted scopes allow. No scope → nothing.
 *
 * An administrator's bundle is a single unlimited token rather than a list, so
 * it cannot be filtered as it stands. Under a narrower scope it is first
 * expanded to `universe` — every capability a tool can require — and then
 * filtered like anyone else's.
 */
export function narrowCapabilitiesByScopes(
  capabilities: readonly string[],
  scopes: readonly string[],
  universe: readonly string[] = [],
): string[] {
  if (scopes.includes(MCP_SCOPE.admin)) return [...capabilities];
  const canWriteContent = scopes.includes(MCP_SCOPE.write);
  const canRead = canWriteContent || scopes.includes(MCP_SCOPE.read);
  if (!canRead) return [];
  const unlimited = capabilities.some((capability) => UNLIMITED_CAPABILITY_TOKENS.includes(capability));
  const held = unlimited ? [...new Set(universe)] : capabilities;
  return held.filter((capability) => {
    const [namespace, action] = capability.split(':');
    if (action === 'read') return true;
    return canWriteContent && CONTENT_NAMESPACES.has(namespace ?? '');
  });
}
