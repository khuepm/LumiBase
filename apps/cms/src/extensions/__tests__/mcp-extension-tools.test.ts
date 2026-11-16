import { describe, expect, it } from 'vitest';
import {
  extensionMcpManifestSchema,
  extensionToolName,
  parseExtensionMcpManifest,
} from '@lumibase/contracts/extensions';
import { McpService, type McpHarnessPort } from '../../services/mcp-service';
import { extensionSchema } from '../../services/extensions-service';
import { extensionKeyOf, extensionToolGovernance } from '../mcp-extension-tools';

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'appendNote',
  description: 'Append',
  capability: 'notes:write',
  riskClass: 'low',
  inputSchema: { type: 'object', properties: {} },
  ...over,
});

describe('extension MCP manifest contract (#715)', () => {
  it('accepts a full block and defaults the missing lists', () => {
    expect(parseExtensionMcpManifest({ mcp: { tools: [tool()] } })).toEqual({
      tools: [tool()],
      prompts: [],
      resources: [],
    });
    expect(parseExtensionMcpManifest({})).toBeNull();
    expect(parseExtensionMcpManifest(null)).toBeNull();
  });

  it.each([
    ['bad name', tool({ name: 'Bad-Name' })],
    ['bad capability', tool({ capability: 'admin' })],
    ['unknown risk', tool({ riskClass: 'none' })],
    ['non-object schema', tool({ inputSchema: { type: 'string' } })],
    ['empty description', tool({ description: '  ' })],
  ])('refuses a tool with %s', (_label, entry) => {
    expect(extensionMcpManifestSchema.safeParse({ tools: [entry] }).success).toBe(false);
  });

  it('refuses duplicate names', () => {
    expect(extensionMcpManifestSchema.safeParse({ tools: [tool(), tool()] }).success).toBe(false);
    const prompt = { name: 'style', text: 'x' };
    expect(extensionMcpManifestSchema.safeParse({ prompts: [prompt, prompt] }).success).toBe(false);
  });

  it('prefixes advertised tool names so a core skill cannot be shadowed', () => {
    expect(extensionToolName('notes', 'deleteCollection')).toBe('ext_notes__deleteCollection');
    expect(extensionToolName('My-Ext:v2', 'run')).toBe('ext_my_ext_v2__run');
    expect(extensionToolName('x'.repeat(60), 'run')).toBeNull();
    expect(extensionToolName('---', 'run')).toBeNull();
  });

  it('derives the extension key like the installer does', () => {
    expect(extensionKeyOf({ key: null, name: 'Word Count' })).toBe('word_count');
    expect(extensionKeyOf({ key: 'wc', name: 'Word Count' })).toBe('wc');
  });
});

describe('extensionToolGovernance — HITL rule', () => {
  it('maps risk classes onto external-action governance', () => {
    expect(extensionToolGovernance(tool({ riskClass: 'read_only' }) as never)).toEqual({
      risk: 'low', reversibility: 'read_only', blastRadius: { scope: 'none' },
    });
    expect(extensionToolGovernance(tool({ riskClass: 'medium' }) as never)).toMatchObject({ risk: 'medium', reversibility: 'reversible' });
    expect(extensionToolGovernance(tool({ riskClass: 'low', reversible: false }) as never)).toMatchObject({ reversibility: 'irreversible' });
  });

  it('forces schema:write and delete* tools to high risk, even when declared read_only', () => {
    expect(extensionToolGovernance(tool({ capability: 'schema:write', riskClass: 'read_only' }) as never)).toMatchObject({ risk: 'high' });
    expect(extensionToolGovernance(tool({ name: 'deleteNotes', riskClass: 'low' }) as never)).toMatchObject({ risk: 'high' });
  });
});

describe('ExtensionsService manifest validation', () => {
  const base = { name: 'n', version: '1', type: 'hook', bundleUrl: 'https://ext.invalid/a.mjs' };

  it('keeps accepting string metadata and accepts a valid mcp block', () => {
    expect(extensionSchema.safeParse({ ...base, manifest: { author: 'me', mcp: { tools: [tool()] } } }).success).toBe(true);
  });

  it('refuses a malformed mcp block and non-string metadata at install time', () => {
    const bad = extensionSchema.safeParse({ ...base, manifest: { mcp: { tools: [{ name: 'x' }] } } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path[0]).toBe('manifest');
    expect(extensionSchema.safeParse({ ...base, manifest: { author: 3 } }).success).toBe(false);
  });
});

describe('McpService — resources and extension prompts', () => {
  const resource = { uri: 'lumibase-ext://notes/glossary', name: 'glossary', mimeType: 'text/markdown', text: '# G' };
  const port: McpHarnessPort = {
    listTools: async () => [],
    execute: async () => ({ status: 'denied' }),
    listResources: async (caps) => (caps.includes('items:read') ? [resource] : []),
    readResource: async (uri, caps) => (caps.includes('items:read') && uri === resource.uri ? resource : null),
    listPrompts: async () => [{ name: 'ext:notes:style' }],
    getPrompt: async (name) =>
      name === 'ext:notes:style' ? { name, text: 'Be brief.', extension: { key: 'notes', version: '1.0.0' } } : null,
  };
  const mcp = new McpService(port);

  it('advertises the resources capability only when the port has resources', async () => {
    const withResources = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, [])) as {
      result: { capabilities: Record<string, unknown> };
    };
    expect(withResources.result.capabilities).toHaveProperty('resources');
    const bare = (await new McpService({ listTools: async () => [], execute: async () => ({ status: 'denied' }) }).handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      [],
    )) as { result: { capabilities: Record<string, unknown> } };
    expect(bare.result.capabilities).not.toHaveProperty('resources');
    const unsupported = (await new McpService({ listTools: async () => [], execute: async () => ({ status: 'denied' }) }).handle(
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      [],
    )) as { error: { code: number } };
    expect(unsupported.error.code).toBe(-32601);
  });

  it('lists and reads a resource for a permitted caller, and hides it otherwise', async () => {
    const listed = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, ['items:read'])) as {
      result: { resources: unknown[] };
    };
    expect(listed.result.resources).toEqual([{ uri: resource.uri, name: 'glossary', mimeType: 'text/markdown' }]);
    const read = (await mcp.handle(
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: resource.uri } },
      ['items:read'],
    )) as { result: { contents: unknown[] } };
    expect(read.result.contents).toEqual([{ uri: resource.uri, mimeType: 'text/markdown', text: '# G' }]);

    const hidden = (await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, [])) as {
      result: { resources: unknown[] };
    };
    expect(hidden.result.resources).toEqual([]);
    const denied = (await mcp.handle(
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: resource.uri } },
      [],
    )) as { error: { code: number; message: string } };
    expect(denied.error).toEqual({ code: -32602, message: `Unknown resource: ${resource.uri}` });
    const missingUri = (await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: {} }, [])) as {
      error: { code: number };
    };
    expect(missingUri.error.code).toBe(-32602);
  });

  it('stamps an extension prompt with extension provenance, not site-skill provenance', async () => {
    const got = (await mcp.handle(
      { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'ext:notes:style' } },
      [],
    )) as { result: { _meta: Record<string, unknown>; messages: unknown[] } };
    expect(got.result._meta).toEqual({ 'lumibase/extension': { key: 'notes', version: '1.0.0' } });
    expect(got.result.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Be brief.' } }]);
  });
});

describe('examples/extension-mcp-notes', () => {
  it('ships a manifest the installer accepts, with the schema:write tool forced to high', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('../../../../../examples/extension-mcp-notes/manifest.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const block = parseExtensionMcpManifest(manifest)!;
    expect(block.tools.map((entry) => entry.name)).toEqual(['countNotes', 'appendNote', 'addNotesField']);
    const addField = block.tools.find((entry) => entry.name === 'addNotesField')!;
    expect(extensionToolGovernance(addField)).toMatchObject({ risk: 'high' });
    const { mcp, ...metadata } = manifest;
    expect(
      extensionSchema.safeParse({
        name: manifest['name'], version: manifest['version'], type: manifest['type'],
        bundleUrl: 'https://ext.invalid/mcp-notes.mjs',
        manifest: { description: metadata['description'], mcp },
      }).success,
    ).toBe(true);
  });
});
