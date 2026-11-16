import { describe, expect, it } from 'vitest';
import { buildMcpConfig } from '../mcp-setup';

describe('IDE MCP configuration', () => {
  it.each([
    ['cursor', 'mcpServers'],
    ['vscode', 'servers'],
  ] as const)('uses the correct %s format and a dedicated token', (format, rootKey) => {
    const config = JSON.parse(buildMcpConfig(format, 'https://api.lumibase.dev', 'site_1', 'lbk_secret'));
    const server = config[rootKey].lumibase;

    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@lumibase/mcp-server']);
    expect(server.env).toEqual({
      LUMIBASE_URL: 'https://api.lumibase.dev',
      LUMIBASE_SITE_ID: 'site_1',
      LUMIBASE_TOKEN: 'lbk_secret',
    });
  });
});
