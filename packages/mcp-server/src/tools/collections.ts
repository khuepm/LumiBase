import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type LumiBaseClient, LumiBaseApiError } from '../client.js';

const collectionNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Must be lowercase, start with a letter, only a-z0-9_');

const collectionInputSchema = z.object({
  name: collectionNameSchema,
  label: z.string().optional(),
  pluralLabel: z.string().optional(),
  hidden: z.boolean().optional(),
  singleton: z.boolean().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  note: z.string().optional(),
  primaryKeyField: z.string().optional(),
  primaryKeyType: z.enum(['nanoid', 'uuid', 'integer', 'bigInteger', 'string']).optional(),
  storageMode: z.enum(['jsonb', 'materialized', 'physical', 'external']).optional(),
  displayTemplate: z.string().optional(),
  sortField: z.string().optional(),
  archiveField: z.string().optional(),
  archiveValue: z.string().optional(),
  unarchiveValue: z.string().optional(),
  accountability: z.enum(['all', 'activity', 'none']).optional(),
  versioning: z.boolean().optional(),
});

const fieldInputSchema = z.object({
  name: collectionNameSchema,
  type: z.string().min(1),
  interface: z.string().min(1),
  display: z.string().optional(),
  label: z.string().optional(),
  note: z.string().optional(),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
  searchable: z.boolean().optional(),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  hidden: z.boolean().optional(),
  width: z.enum(['half', 'full', 'fill']).optional(),
  sortOrder: z.number().int().optional(),
  group: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  defaultValue: z.unknown().optional(),
});

function formatError(err: unknown): string {
  if (err instanceof LumiBaseApiError) {
    return err.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
  }
  return String(err);
}

export function registerCollectionTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_collections',
    {
      description: 'List all collections in the LumiBase site.',
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.get<unknown[]>('/collections');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_collection',
    {
      description: 'Get a collection with its compiled schema (all fields, system fields, meta).',
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => {
      try {
        const data = await client.get<unknown>(`/collections/${name}/compiled`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'create_collection',
    {
      description:
        'Create a new collection. Name must be lowercase snake_case (e.g. "blog_posts"). ' +
        'storageMode defaults to "jsonb" (recommended for most use-cases). ' +
        'primaryKeyType defaults to "nanoid".',
      inputSchema: collectionInputSchema.shape,
    },
    async (input) => {
      try {
        const data = await client.post<unknown>('/collections', input);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'update_collection',
    {
      description: 'Update metadata on an existing collection (label, icon, note, accountability, etc.).',
      inputSchema: {
        name: z.string().min(1),
        patch: collectionInputSchema.omit({ name: true }).partial(),
      },
    },
    async ({ name, patch }) => {
      try {
        const data = await client.patch<unknown>(`/collections/${name}`, patch);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'delete_collection',
    {
      description:
        'Delete a collection and all its items. DESTRUCTIVE — cannot be undone. ' +
        'You MUST pass confirm=true explicitly after warning the user.',
      inputSchema: {
        name: z.string().min(1),
        confirm: z.literal(true).describe('Must be true to confirm destructive operation'),
      },
    },
    async ({ name, confirm: _ }) => {
      try {
        await client.delete(`/collections/${name}`);
        return { content: [{ type: 'text', text: `Collection "${name}" deleted.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'diff_schema',
    {
      description:
        'Preview what would change if you applied a schema update. ' +
        'Returns added/modified/removed fields and any risky changes. ' +
        'Always call this before apply_schema to check for breaking changes.',
      inputSchema: {
        name: z.string().min(1),
        fields: z.array(fieldInputSchema).optional(),
        label: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const data = await client.post<unknown>('/collections/diff', input);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'apply_schema',
    {
      description:
        'Atomically apply a schema migration to a collection (add/update/remove fields and relations). ' +
        'Call diff_schema first to preview changes. Pass confirmRiskyChange=true on field inputs that have risky changes.',
      inputSchema: {
        name: z.string().min(1),
        fields: z.array(
          fieldInputSchema.extend({
            renameFrom: z.string().optional(),
            confirmRiskyChange: z.boolean().optional(),
          }),
        ).optional(),
        label: z.string().optional(),
        note: z.string().optional(),
        accountability: z.enum(['all', 'activity', 'none']).optional(),
        versioning: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const { name, ...rest } = input;
        const data = await client.put<unknown>(`/collections/${name}/schema`, rest);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );
}
