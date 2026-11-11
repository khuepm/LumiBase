import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type LumiBaseClient, LumiBaseApiError } from '../client.js';
import { collectionNameSchema, encodePathSegment, fieldNameSchema } from './path.js';
import { okAfter } from './_shared.js';

/**
 * Nullability mirrors `collectionInputSchema` in `apps/cms/src/routes/collections.ts`.
 * The REST route takes `null` to clear these columns; advertising them as plain
 * strings made `update_collection { patch: { sortField: null } }` unsendable by
 * a schema-respecting client (#716, the `{type:"null"}` class of Payload #16214).
 */
const collectionInputSchema = z.object({
  name: collectionNameSchema,
  label: z.string().nullable().optional(),
  pluralLabel: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  singleton: z.boolean().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  primaryKeyField: z.string().optional(),
  primaryKeyType: z.enum(['nanoid', 'uuid', 'integer', 'bigInteger', 'string']).optional(),
  storageMode: z.enum(['jsonb', 'materialized', 'physical', 'external']).optional(),
  displayTemplate: z.string().nullable().optional(),
  sortField: z.string().nullable().optional(),
  archiveField: z.string().nullable().optional(),
  archiveValue: z.string().nullable().optional(),
  unarchiveValue: z.string().nullable().optional(),
  accountability: z.enum(['all', 'activity', 'none']).optional(),
  versioning: z.boolean().optional(),
});

/** Nullability mirrors the REST `fieldInputSchema` (same route file). */
const fieldInputSchema = z.object({
  name: fieldNameSchema,
  type: z.string().min(1),
  interface: z.string().min(1),
  display: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
  searchable: z.boolean().optional(),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  hidden: z.boolean().optional(),
  width: z.enum(['half', 'full', 'fill']).optional(),
  sortOrder: z.number().int().optional(),
  group: z.string().nullable().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
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
      inputSchema: { name: collectionNameSchema },
    },
    async ({ name }) => {
      try {
        const data = await client.get<unknown>(`/collections/${encodePathSegment(name)}/compiled`);
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
        name: collectionNameSchema,
        patch: collectionInputSchema.omit({ name: true }).partial(),
      },
    },
    async ({ name, patch }) => {
      try {
        const data = await client.patch<unknown>(`/collections/${encodePathSegment(name)}`, patch);
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
        name: collectionNameSchema,
        confirm: z.literal(true).describe('Must be true to confirm destructive operation'),
      },
    },
    async ({ name, confirm: _ }) => {
      try {
        const response = await client.delete(`/collections/${encodePathSegment(name)}`);
        return okAfter(response, `Collection "${name}" deleted.`);
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
        name: collectionNameSchema,
        fields: z.array(fieldInputSchema).optional(),
        label: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
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
        name: collectionNameSchema,
        fields: z.array(
          fieldInputSchema.extend({
            renameFrom: fieldNameSchema.optional(),
            confirmRiskyChange: z.boolean().optional(),
          }),
        ).optional(),
        label: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
        accountability: z.enum(['all', 'activity', 'none']).optional(),
        versioning: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const { name, ...rest } = input;
        const data = await client.put<unknown>(
          `/collections/${encodePathSegment(name)}/schema`,
          rest,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );
}
