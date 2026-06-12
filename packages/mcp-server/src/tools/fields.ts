import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type LumiBaseClient, LumiBaseApiError } from '../client.js';

const namePattern = /^[a-z][a-z0-9_]{0,62}$/;

const fieldInputSchema = z.object({
  type: z.string().min(1).describe(
    'Storage type: string, text, integer, bigInteger, float, decimal, boolean, ' +
    'date, dateTime, time, json, uuid, csv, hash, alias',
  ),
  interface: z.string().min(1).describe(
    'UI widget: input, textarea, select, toggle, datetime, file, image, ' +
    'repeater, relation-m2o, relation-o2m, relation-m2m, code, markdown, wysiwyg, …',
  ),
  display: z.string().optional(),
  label: z.string().optional(),
  note: z.string().optional(),
  defaultValue: z.unknown().optional(),
  nullable: z.boolean().optional().default(true),
  unique: z.boolean().optional().default(false),
  indexed: z.boolean().optional().default(false),
  searchable: z.boolean().optional().default(false),
  length: z.number().int().positive().optional(),
  precision: z.number().int().positive().optional(),
  scale: z.number().int().min(0).optional(),
  special: z.array(z.string()).optional(),
  options: z.record(z.unknown()).optional(),
  displayOptions: z.record(z.unknown()).optional(),
  conditions: z.array(z.unknown()).optional(),
  required: z.boolean().optional().default(false),
  readonly: z.boolean().optional().default(false),
  hidden: z.boolean().optional().default(false),
  encrypted: z.boolean().optional().default(false),
  versioned: z.boolean().optional().default(false),
  width: z.enum(['half', 'full', 'fill']).optional().default('full'),
  group: z.string().optional(),
  sortOrder: z.number().int().optional(),
  renameFrom: z
    .string()
    .regex(namePattern)
    .optional()
    .describe('Previous field name if this is a rename operation'),
  confirmRiskyChange: z
    .boolean()
    .optional()
    .describe('Set true to confirm type-change or destructive migration'),
});

function formatError(err: unknown): string {
  if (err instanceof LumiBaseApiError) {
    return err.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
  }
  return String(err);
}

export function registerFieldTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_fields',
    {
      description: 'List all fields in a collection, including system fields.',
      inputSchema: {
        collection: z.string().min(1),
      },
    },
    async ({ collection }) => {
      try {
        const data = await client.get<unknown[]>(`/collections/${collection}/fields`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'upsert_field',
    {
      description:
        'Create or update a field in a collection. ' +
        'field_name must be lowercase snake_case (e.g. "published_at"). ' +
        'Common types: string (varchar), text (longtext), integer, boolean, dateTime, json, uuid. ' +
        'Common interfaces: input, textarea, datetime, toggle, select, file, markdown.',
      inputSchema: {
        collection: z.string().min(1),
        field_name: z
          .string()
          .regex(namePattern, 'Must be lowercase snake_case, start with a letter')
          .describe('Machine name of the field'),
        ...fieldInputSchema.shape,
      },
    },
    async ({ collection, field_name, ...fieldInput }) => {
      try {
        const data = await client.put<unknown>(
          `/collections/${collection}/fields/${field_name}`,
          fieldInput,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'delete_field',
    {
      description:
        'Delete a field from a collection. ' +
        'Data stored in this field will be lost. ' +
        'Pass confirm=true to confirm the destructive operation.',
      inputSchema: {
        collection: z.string().min(1),
        field_name: z.string().min(1),
        confirm: z.literal(true).describe('Must be true to confirm destructive operation'),
        force: z.boolean().optional().describe('Force deletion even if risky (foreign keys, etc.)'),
      },
    },
    async ({ collection, field_name, force }) => {
      try {
        const qs = force ? '?force=true' : '';
        await client.delete(`/collections/${collection}/fields/${field_name}${qs}`);
        return {
          content: [{ type: 'text', text: `Field "${field_name}" deleted from "${collection}".` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );
}
