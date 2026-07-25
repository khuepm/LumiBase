import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, okText, run } from './_shared.js';

export function registerOpsTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_activity',
    {
      description: 'List the site activity / audit trail (most recent first).',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/activity${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  server.registerTool(
    'get_site',
    {
      description: 'Get the current site’s configuration record (name, domain, settings).',
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/site')),
  );

  server.registerTool(
    'get_health',
    { description: 'Check the CMS health endpoint.', inputSchema: {} },
    async () => run(async () => okText(await client.getRootText('/health'))),
  );

  server.registerTool(
    'get_metrics',
    { description: 'Fetch Prometheus metrics exposition text from the CMS.', inputSchema: {} },
    async () => run(async () => okText(await client.getRootText('/metrics'))),
  );
}
