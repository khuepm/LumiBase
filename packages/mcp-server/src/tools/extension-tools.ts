import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';
import { asGovernedDecision, fail, renderDecision } from './_shared.js';

/**
 * Extension-contributed tools on the stdio transport (#715).
 *
 * Extension tools exist per site and are installed at runtime, so this package
 * cannot ship them statically like the core tools. They are discovered once at
 * startup from the governed endpoint's `tools/list` (names `ext_<key>__<tool>`)
 * and every call is forwarded to `POST /api/v1/mcp` `tools/call` — the same
 * harness path as the HTTP transport. There is no REST fallback: an extension
 * tool that cannot reach the harness is refused, never run ungoverned.
 *
 * Not offered when the governed endpoint is unavailable (`contentOs.mcp` off),
 * in read-only mode, or for an organization token not pinned to a site.
 */

export const EXTENSION_TOOL_PREFIX = 'ext_';

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * A zod shape mirroring the top level of a JSON Schema object. Only used so
 * the MCP client sees typed parameters; the authoritative validation happens
 * in the harness against the declared schema.
 */
export function zodShapeFromJsonSchema(schema: Record<string, unknown> | undefined): z.ZodRawShape {
  const properties =
    schema && typeof schema['properties'] === 'object' && schema['properties'] !== null
      ? (schema['properties'] as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(Array.isArray(schema?.['required']) ? (schema['required'] as unknown[]).map(String) : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, spec] of Object.entries(properties)) {
    let field: z.ZodType;
    switch (spec?.['type']) {
      case 'string':
        field = Array.isArray(spec['enum']) && spec['enum'].every((v) => typeof v === 'string') && spec['enum'].length > 0
          ? z.enum(spec['enum'] as [string, ...string[]])
          : z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.unknown();
    }
    if (typeof spec?.['description'] === 'string') field = field.describe(spec['description']);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

/**
 * Discovers and registers the site's extension tools. Resolves to the number
 * registered; never throws (an unreachable endpoint just means none).
 */
export async function registerExtensionTools(server: McpServer, client: LumiBaseClient): Promise<number> {
  if (client.readOnly) return 0;
  if (client.tokenKind === 'organization' && !client.siteId) return 0;
  let listed: { tools?: ListedTool[] } | undefined;
  try {
    listed = await client.jsonRpc<{ tools?: ListedTool[] }>('tools/list');
  } catch {
    return 0;
  }
  let count = 0;
  for (const tool of listed?.tools ?? []) {
    if (typeof tool?.name !== 'string' || !tool.name.startsWith(EXTENSION_TOOL_PREFIX)) continue;
    const name = tool.name;
    server.registerTool(
      name,
      {
        description: tool.description ?? name,
        inputSchema: zodShapeFromJsonSchema(tool.inputSchema),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const result = await client.jsonRpc<{
            content?: Array<{ type: 'text'; text: string }>;
            structuredContent?: Record<string, unknown>;
          }>('tools/call', { name, arguments: args });
          const decision = asGovernedDecision(result?.structuredContent);
          if (decision) return renderDecision(decision, `${name} executed.`);
          return { content: result?.content ?? [{ type: 'text', text: JSON.stringify(result ?? null) }], isError: true };
        } catch (err) {
          return fail(err);
        }
      },
    );
    count += 1;
  }
  return count;
}
