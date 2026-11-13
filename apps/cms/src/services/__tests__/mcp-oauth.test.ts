import { describe, expect, it } from 'vitest';
import {
  MCP_SCOPES,
  authorizationServersFor,
  bearerChallenge,
  buildProtectedResourceMetadata,
  canonicalMcpPath,
  isMcpResourceUri,
  mcpPathFromMetadataPath,
  mcpSiteIdFromPath,
  narrowCapabilitiesByScopes,
  publicBaseUrl,
  scopeForCapability,
  scopesForCapabilities,
  scopesFromClaims,
} from '../mcp-oauth';

/** #346 — pure helpers behind the MCP OAuth 2.1 protected-resource surface. */

describe('MCP resource paths', () => {
  it('canonicalises the base and site-addressed endpoints', () => {
    expect(canonicalMcpPath('/api/v1/mcp')).toBe('/api/v1/mcp');
    expect(canonicalMcpPath('/api/v1/mcp/')).toBe('/api/v1/mcp');
    expect(canonicalMcpPath('/api/v1/mcp/sites/site_1')).toBe('/api/v1/mcp/sites/site_1');
    expect(canonicalMcpPath('/api/v1/mcp/sites/site_1/')).toBe('/api/v1/mcp/sites/site_1');
    expect(canonicalMcpPath('/api/v1/mcp/sites/a/b')).toBeNull();
    expect(canonicalMcpPath('/api/v1/items')).toBeNull();
  });

  it('extracts the site id from the endpoint and from its metadata path', () => {
    expect(mcpSiteIdFromPath('/api/v1/mcp/sites/site_1')).toBe('site_1');
    expect(mcpSiteIdFromPath('/.well-known/oauth-protected-resource/api/v1/mcp/sites/site_1')).toBe('site_1');
    expect(mcpSiteIdFromPath('/api/v1/mcp')).toBeNull();
    expect(mcpSiteIdFromPath('/api/v1/mcp/sites/%E0%A4%A')).toBe('');
  });

  it('maps metadata paths to the resource path they describe', () => {
    expect(mcpPathFromMetadataPath('/.well-known/oauth-protected-resource')).toBe('/api/v1/mcp');
    expect(mcpPathFromMetadataPath('/.well-known/oauth-protected-resource/api/v1/mcp')).toBe('/api/v1/mcp');
    expect(mcpPathFromMetadataPath('/.well-known/oauth-protected-resource/api/v1/mcp/sites/s')).toBe('/api/v1/mcp/sites/s');
    expect(mcpPathFromMetadataPath('/.well-known/oauth-protected-resource/api/v1/items')).toBeNull();
  });

  it('recognises an MCP resource URI on any origin', () => {
    expect(isMcpResourceUri('https://cms.acme.com/api/v1/mcp')).toBe(true);
    expect(isMcpResourceUri('https://other.example/api/v1/mcp/sites/s1')).toBe(true);
    expect(isMcpResourceUri('https://cms.acme.com/api/v1/items')).toBe(false);
    expect(isMcpResourceUri('lumibase-api')).toBe(false);
  });
});

describe('publicBaseUrl', () => {
  it('prefers LUMIBASE_PUBLIC_URL and strips trailing slashes', () => {
    expect(publicBaseUrl({ url: 'http://internal:1989/x', env: { LUMIBASE_PUBLIC_URL: 'https://cms.acme.com/' } })).toBe('https://cms.acme.com');
  });

  it('falls back to the request origin, upgraded by x-forwarded-proto=https', () => {
    const prev = process.env.LUMIBASE_PUBLIC_URL;
    delete process.env.LUMIBASE_PUBLIC_URL;
    try {
      expect(publicBaseUrl({ url: 'http://cms.acme.com/api/v1/mcp' })).toBe('http://cms.acme.com');
      expect(publicBaseUrl({ url: 'http://cms.acme.com/api/v1/mcp', forwardedProto: 'https' })).toBe('https://cms.acme.com');
    } finally {
      if (prev !== undefined) process.env.LUMIBASE_PUBLIC_URL = prev;
    }
  });
});

describe('scopes', () => {
  it('reads `scope` (space-delimited) and `scp` (string or array)', () => {
    expect(scopesFromClaims({ scope: 'mcp:read  mcp:write' }).sort()).toEqual(['mcp:read', 'mcp:write']);
    expect(scopesFromClaims({ scp: ['mcp:read', 7] })).toEqual(['mcp:read']);
    expect(scopesFromClaims({})).toEqual([]);
  });

  it('classifies capabilities by verb, with ai:decide under admin', () => {
    expect(scopeForCapability('items:read')).toBe(MCP_SCOPES.read);
    expect(scopeForCapability('items:write')).toBe(MCP_SCOPES.write);
    expect(scopeForCapability('flows:run')).toBe(MCP_SCOPES.write);
    expect(scopeForCapability('schema:delete')).toBe(MCP_SCOPES.delete);
    expect(scopeForCapability('ai:decide')).toBe(MCP_SCOPES.admin);
    expect(scopesForCapabilities(['items:write', 'items:read', 'items:update'])).toEqual(['mcp:read', 'mcp:write']);
  });
});

describe('narrowCapabilitiesByScopes — never widens', () => {
  const universe = ['items:read', 'items:write', 'schema:read', 'schema:delete', 'ai:decide'];

  it('keeps only capabilities whose verb scope was granted', () => {
    expect(narrowCapabilitiesByScopes(['items:read', 'items:write'], ['mcp:read'], universe)).toEqual(['items:read']);
  });

  it('never adds a capability the RBAC grant lacks, whatever the scopes say', () => {
    const all = ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin', 'schema:delete'];
    expect(narrowCapabilitiesByScopes(['items:read'], all, universe)).toEqual(['items:read']);
  });

  it('accepts an exact capability string as a scope', () => {
    expect(narrowCapabilitiesByScopes(['items:read', 'schema:read'], ['schema:read'], universe)).toEqual(['schema:read']);
  });

  it('no recognised scope ⇒ no capabilities', () => {
    expect(narrowCapabilitiesByScopes(['items:read'], ['openid', 'profile'], universe)).toEqual([]);
  });

  it('keeps the admin marker only when all four MCP scopes are granted', () => {
    expect(narrowCapabilitiesByScopes(['admin'], ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin'], universe)).toEqual(['admin']);
  });

  it('expands an admin marker into the universe, then filters, when scopes are partial', () => {
    expect(narrowCapabilitiesByScopes(['admin'], ['mcp:read'], universe)).toEqual(['items:read', 'schema:read']);
    expect(narrowCapabilitiesByScopes(['*'], ['mcp:read'], universe)).not.toContain('*');
  });
});

describe('challenge + metadata', () => {
  it('builds the discovery challenge and the step-up challenge', () => {
    const md = 'https://cms.acme.com/.well-known/oauth-protected-resource/api/v1/mcp';
    expect(bearerChallenge({ resourceMetadata: md })).toBe(`Bearer resource_metadata="${md}"`);
    expect(bearerChallenge({ resourceMetadata: md, error: 'insufficient_scope', scope: ['mcp:write', 'mcp:admin'] })).toBe(
      `Bearer error="insufficient_scope", scope="mcp:write mcp:admin", resource_metadata="${md}"`,
    );
    expect(bearerChallenge({ resourceMetadata: 'a"b', description: 'x\\y' })).toBe(
      'Bearer error_description="x\\\\y", resource_metadata="a\\"b"',
    );
  });

  it('lists only enabled issuers whose audience includes the exact resource URI', () => {
    const resource = 'https://cms.acme.com/api/v1/mcp';
    const servers = authorizationServersFor(
      [
        { issuer: 'https://auth.acme.com/oidc', audience: [resource, 'lumibase-api'], enabled: true },
        { issuer: 'https://other.example', audience: 'lumibase-api', enabled: true },
        { issuer: 'https://disabled.example', audience: resource, enabled: false },
        { issuer: 'https://prefix.example', audience: `${resource}/sites/x`, enabled: true },
      ],
      resource,
    );
    expect(servers).toEqual(['https://auth.acme.com/oidc']);
  });

  it('builds an RFC 9728 document with header-only bearer usage', () => {
    const doc = buildProtectedResourceMetadata({ resource: 'https://x/api/v1/mcp', authorizationServers: ['https://as'] });
    expect(doc).toMatchObject({
      resource: 'https://x/api/v1/mcp',
      authorization_servers: ['https://as'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin'],
    });
  });
});

describe('tools/list title + annotations (ported from #805)', async () => {
  const { McpService, toolAnnotations, toolTitle } = await import('../mcp-service');

  it('humanises tool names', () => {
    expect(toolTitle('listItems')).toBe('List items');
    expect(toolTitle('org:list_sites')).toBe('Org list sites');
  });

  it('marks read-only only for safe, all-:read tools; destructive only for dangerous', () => {
    expect(toolAnnotations({ requiredCapabilities: ['items:read'], riskPolicy: { level: 'safe' } })).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(toolAnnotations({ requiredCapabilities: [], riskPolicy: { level: 'safe' } })).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations({ requiredCapabilities: ['items:read', 'items:write'], riskPolicy: { level: 'safe' } })).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations({ requiredCapabilities: ['schema:delete'], riskPolicy: { level: 'dangerous' } })).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it('projects title and annotations into tools/list', async () => {
    const service = new McpService({
      listTools: async () => [
        { name: 'listItems', description: 'd', title: 'List items', annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: 'plain', description: 'd' },
      ],
      execute: async () => ({ status: 'executed' }) as never,
    });
    const res = (await service.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, [])) as { result: { tools: Array<Record<string, unknown>> } };
    expect(res.result.tools[0]).toMatchObject({ title: 'List items', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(res.result.tools[1]).not.toHaveProperty('title');
    expect(res.result.tools[1]).not.toHaveProperty('annotations');
  });
});
