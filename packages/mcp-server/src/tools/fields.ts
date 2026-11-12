import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type LumiBaseClient, LumiBaseApiError } from '../client.js';
import { collectionNameSchema, encodePathSegment, fieldNameSchema } from './path.js';
import { okAfter } from './_shared.js';

/**
 * Mirrors the REST `fieldInputSchema` in `apps/cms/src/routes/collections.ts`,
 * minus `name` (the field is named by the URL here). Exported so `apply_schema`
 * and `diff_schema` build their `fields[]` from this one object instead of a
 * second copy that drifted (#716 review: the copy lacked 12 keys, so
 * `encrypted`/`classification` were stripped and the field created plaintext).
 * The fidelity suite compares it key by key with the REST golden.
 *
 * Two fidelity rules (#716):
 *   - columns the route takes as `null` (to clear them) are `.nullable()` here,
 *     so the advertised JSON Schema carries `{type:"null"}` for them;
 *   - no `.default()`. `PUT …/fields/:field` is an upsert and an update is a
 *     PARTIAL patch, but the SDK applies Zod defaults before the handler runs,
 *     so every `upsert_field` that only changed a label also sent
 *     `required:false, hidden:false, encrypted:false, width:"full", …` and
 *     silently reset those columns. On create the database column defaults
 *     apply, exactly as for a REST caller that omits them.
 */
export const fieldDefinitionSchema = z.object({
  // The canonical vocabulary is `FieldType` (`@lumibase/contracts`): `datetime`,
  // not `dateTime`; no `float`. The server stores any string (B206).
  type: z.string().min(1).describe(
    'Storage type (FieldType): string, text, integer, bigInteger, decimal, boolean, ' +
    'date, datetime, time, timestamp, json, uuid, csv, hash, geometry, alias. ' +
    'Not validated server-side; GraphQL currently types `datetime` as String (B206).',
  ),
  interface: z.string().min(1).describe(
    'UI widget: input, textarea, select, toggle, datetime, file, image, ' +
    'repeater, relation-m2o, relation-o2m, relation-m2m, code, markdown, wysiwyg, …',
  ),
  display: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  defaultValue: z.unknown().optional(),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
  searchable: z.boolean().optional(),
  length: z.number().int().positive().nullable().optional(),
  precision: z.number().int().positive().nullable().optional(),
  scale: z.number().int().min(0).nullable().optional(),
  special: z.array(z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  displayOptions: z.record(z.string(), z.unknown()).optional(),
  validation: z.record(z.string(), z.unknown()).optional(),
  conditions: z.array(z.unknown()).optional(),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  hidden: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  // Accepted by REST but missing here, so the SDK stripped them and a
  // `classification: "pii"` request returned success without classifying.
  classification: z.enum(['none', 'internal', 'pii', 'phi']).optional()
    .describe('Data sensitivity; pii/phi require encrypted=true.'),
  versioned: z.boolean().optional(),
  rawEnabled: z.boolean().optional(),
  width: z.enum(['half', 'full', 'fill']).optional(),
  group: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  renameFrom: fieldNameSchema
    .optional()
    .describe('Previous field name if this is a rename operation'),
  // REST semantics, kept on purpose: any object (even `{}`) passes the
  // risky-change guard like `confirmRiskyChange: true`, and the plan itself is
  // not executed (`toFieldDbInput` discards it). See backlog B207.
  migrationPlan: z.record(z.string(), z.unknown()).optional()
    .describe('Counts as confirmation of a risky change, like confirmRiskyChange=true. The plan is not executed yet.'),
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
        collection: collectionNameSchema,
      },
    },
    async ({ collection }) => {
      try {
        const data = await client.get<unknown[]>(`/collections/${encodePathSegment(collection)}/fields`);
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
        'Common types: string (varchar), text (longtext), integer, decimal, boolean, datetime, json, uuid. ' +
        'Common interfaces: input, textarea, datetime, toggle, select, file, markdown.',
      inputSchema: {
        collection: collectionNameSchema,
        field_name: fieldNameSchema.describe('Machine name of the field'),
        ...fieldDefinitionSchema.shape,
      },
    },
    async ({ collection, field_name, ...fieldInput }) => {
      try {
        const data = await client.put<unknown>(
          `/collections/${encodePathSegment(collection)}/fields/${encodePathSegment(field_name)}`,
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
        collection: collectionNameSchema,
        field_name: fieldNameSchema,
        confirm: z.literal(true).describe('Must be true to confirm destructive operation'),
        force: z.boolean().optional().describe('Force deletion even if risky (foreign keys, etc.)'),
      },
    },
    async ({ collection, field_name, force }) => {
      try {
        const qs = force ? '?force=true' : '';
        const response = await client.delete(
          `/collections/${encodePathSegment(collection)}/fields/${encodePathSegment(field_name)}${qs}`,
        );
        return okAfter(response, `Field "${field_name}" deleted from "${collection}".`);
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );
}
