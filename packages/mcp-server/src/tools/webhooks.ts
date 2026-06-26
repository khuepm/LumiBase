import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerCrud } from './_crud.js';

const webhookSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  actions: z.array(z.string()).optional().describe('Item events that trigger the webhook (e.g. create, update, delete).'),
  collections: z.array(z.string()).optional().describe('Collections to filter on (empty = all).'),
  headers: z.record(z.string()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  secret: z.string().nullable().optional(),
});

export function registerWebhookTools(server: McpServer, client: LumiBaseClient) {
  registerCrud(server, client, {
    basePath: '/webhooks',
    resource: 'webhook',
    namePrefix: 'webhook',
    createSchema: webhookSchema.shape,
    updateSchema: webhookSchema.partial().shape,
    // The webhooks route has no GET /:id; list returns full rows.
    enableGet: false,
  });
}
