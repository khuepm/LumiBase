import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type LumiBaseClient, LumiBaseApiError } from '../client.js';
import { collectionNameSchema, encodePathSegment, idPathSegmentSchema } from './path.js';

function formatError(err: unknown): string {
  if (err instanceof LumiBaseApiError) {
    return err.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
  }
  return String(err);
}

function buildQs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function registerItemTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_items',
    {
      description: 'List items from a collection with optional filtering, sorting, and pagination.',
      inputSchema: {
        collection: collectionNameSchema,
        limit: z.number().int().min(1).max(200).optional().default(25),
        offset: z.number().int().min(0).optional().default(0),
        status: z.enum(['draft', 'published', 'archived']).optional(),
        sort: z
          .string()
          .optional()
          .describe('Comma-separated field names; prefix with - for descending (e.g. "-created_at")'),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated field names to return (e.g. "id,title,status")'),
        search: z.string().optional().describe('Full-text search across searchable fields'),
      },
    },
    async ({ collection, ...params }) => {
      try {
        const qs = buildQs(params as Record<string, string | number | boolean | undefined>);
        const data = await client.get<unknown>(`/items/${encodePathSegment(collection)}${qs}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_item',
    {
      description: 'Get a single item by ID from a collection.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        fields: z
          .string()
          .optional()
          .describe('Comma-separated field names to return'),
      },
    },
    async ({ collection, id, fields }) => {
      try {
        const qs = buildQs({ fields });
        const data = await client.get<unknown>(
          `/items/${encodePathSegment(collection)}/${encodePathSegment(id)}${qs}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'create_item',
    {
      description: 'Create a new item in a collection.',
      inputSchema: {
        collection: collectionNameSchema,
        data: z.record(z.string(), z.unknown()).describe('Field values for the new item'),
        status: z.enum(['draft', 'published']).optional().default('draft'),
      },
    },
    async ({ collection, data: itemData, status }) => {
      try {
        const data = await client.post<unknown>(`/items/${encodePathSegment(collection)}`, {
          ...itemData,
          status,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'update_item',
    {
      description: 'Partially update an item (PATCH — only provided fields are changed).',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        data: z.record(z.string(), z.unknown()).describe('Fields to update'),
      },
    },
    async ({ collection, id, data: itemData }) => {
      try {
        const data = await client.patch<unknown>(
          `/items/${encodePathSegment(collection)}/${encodePathSegment(id)}`,
          itemData,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'delete_item',
    {
      description: 'Soft-delete an item (sets deleted_at, recoverable). Pass confirm=true.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        confirm: z.literal(true).describe('Must be true to confirm deletion'),
      },
    },
    async ({ collection, id }) => {
      try {
        await client.delete(`/items/${encodePathSegment(collection)}/${encodePathSegment(id)}`);
        return { content: [{ type: 'text', text: `Item "${id}" deleted from "${collection}".` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );
}
