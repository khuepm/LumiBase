import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type LumiBaseClient, LumiBaseApiError } from '../client.js';
import { collectionNameSchema, encodePathSegment, fieldNameSchema } from './path.js';
import { okAfter } from './_shared.js';
import { fieldDefinitionSchema } from './fields.js';
import { relationInputSchema } from './relations.js';

/**
 * Mirrors `collectionInputSchema` in `apps/cms/src/routes/collections.ts`, key
 * for key; the fidelity suite compares the two through the REST body golden.
 * The REST route takes `null` to clear these columns; advertising them as plain
 * strings made `update_collection { patch: { sortField: null } }` unsendable by
 * a schema-respecting client (#716, the `{type:"null"}` class of Payload #16214).
 */
const collectionInputSchema = z.object({
  name: collectionNameSchema,
  label: z.string().nullable().optional(),
  pluralLabel: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  system: z
    .boolean()
    .optional()
    .describe('Marks a LumiBase-internal collection: excluded from delivery and access-grant listings.'),
  singleton: z.boolean().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  primaryKeyField: fieldNameSchema.optional(),
  primaryKeyType: z.enum(['nanoid', 'uuid', 'integer', 'bigInteger', 'string']).optional(),
  storageMode: z.enum(['jsonb', 'materialized', 'physical', 'external']).optional(),
  displayTemplate: z.string().nullable().optional(),
  sortField: z.string().nullable().optional(),
  archiveField: z.string().nullable().optional(),
  archiveValue: z.string().nullable().optional(),
  unarchiveValue: z.string().nullable().optional(),
  itemDuplicationFields: z.array(z.string()).optional().describe('Fields copied when an item is duplicated.'),
  translations: z.record(z.string(), z.unknown()).optional(),
  accountability: z.enum(['all', 'activity', 'none']).optional(),
  versioning: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** One entry of `fields[]`: the `upsert_field` object plus the field's `name`. */
const schemaFieldSchema = fieldDefinitionSchema.extend({ name: fieldNameSchema });

/**
 * The body of `PUT /collections/:name/schema` and `POST /collections/diff`
 * (REST `schemaInputSchema`): collection metadata, `fields[]` and `relations[]`.
 * `fields`/`relations`, when given, are the COMPLETE list: fields and relations
 * of the collection not in it are deleted on apply.
 */
const schemaBodyShape = {
  ...collectionInputSchema.omit({ name: true }).partial().shape,
  fields: z
    .array(schemaFieldSchema)
    .optional()
    .describe('Complete field list; existing fields missing from it are deleted on apply.'),
  relations: z
    .array(z.object(relationInputSchema))
    .optional()
    .describe('Complete relation list; existing relations missing from it are deleted on apply.'),
};

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
        ...schemaBodyShape,
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
        ...schemaBodyShape,
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
