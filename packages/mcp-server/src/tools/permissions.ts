import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { run } from './_shared.js';

export function registerPermissionTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'get_my_permissions',
    {
      description: 'Get the compiled permission bundle for the authenticated principal.',
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/permissions/me')),
  );

  server.registerTool(
    'check_permission',
    {
      description:
        'Evaluate whether the current principal may perform an action on a collection ' +
        '(optionally against a specific item), returning { allowed, reason, fields }.',
      inputSchema: {
        collection: z.string().min(1),
        action: z.enum(['create', 'read', 'update', 'delete', 'share']),
        item: z.record(z.unknown()).optional().describe('Item payload to evaluate row-level rules against.'),
      },
    },
    async (input) => run(() => client.post<unknown>('/permissions/check', input)),
  );
}
