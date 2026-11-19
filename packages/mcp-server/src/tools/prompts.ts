import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';

/**
 * MCP prompts on the stdio transport (#712, B200).
 *
 * The HTTP endpoint (`POST /api/v1/mcp`) serves the site's active Site Skills
 * — and prompts contributed by granted extensions (#715) — through
 * `prompts/list` / `prompts/get`. Which prompts a caller sees is decided there
 * (a skill body only for a control-plane admin, an extension prompt by its
 * capability), so this module never decides anything: it discovers the list
 * once at startup with the configured token and forwards every `prompts/get`
 * to the same endpoint. A prompt the server stops offering returns its error.
 *
 * Not offered when the governed endpoint is unavailable (`contentOs.mcp` off)
 * or for an organization token not pinned to a site.
 */

interface ListedPrompt {
  name: string;
  title?: string;
  description?: string;
}

export async function registerPromptForwarding(server: McpServer, client: LumiBaseClient): Promise<number> {
  if (client.tokenKind === 'organization' && !client.siteId) return 0;
  let listed: { prompts?: ListedPrompt[] } | undefined;
  try {
    listed = await client.jsonRpc<{ prompts?: ListedPrompt[] }>('prompts/list');
  } catch {
    return 0;
  }
  let count = 0;
  for (const prompt of listed?.prompts ?? []) {
    if (typeof prompt?.name !== 'string' || prompt.name.length === 0) continue;
    const name = prompt.name;
    server.registerPrompt(
      name,
      {
        ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
      },
      async (): Promise<GetPromptResult> => client.jsonRpc<GetPromptResult>('prompts/get', { name }),
    );
    count += 1;
  }
  return count;
}
