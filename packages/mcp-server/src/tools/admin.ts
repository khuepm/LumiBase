import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

const materializeSchema = z.object({
  collection: z.string().min(1).describe('Source collection name.'),
  target: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).describe('Physical table name (snake_case).'),
  refreshStrategy: z.enum(['auto', 'cron', 'manual']).optional(),
  refreshCron: z.string().optional(),
  projection: z
    .object({ fields: z.array(z.string()).optional(), orderBy: z.string().optional() })
    .optional(),
  filter: z.record(z.unknown()).optional(),
});

export function registerAdminTools(server: McpServer, client: LumiBaseClient) {
  // ── Backup / restore ───────────────────────────────────────────────────────
  server.registerTool(
    'export_backup',
    {
      description: 'Export the full site configuration (collections, fields, RBAC, …) as an NDJSON bundle.',
      inputSchema: {},
    },
    async () => run(async () => okText(await client.getText('/admin/backup'))),
  );

  server.registerTool(
    'restore_backup',
    {
      description:
        'Restore a site configuration from an NDJSON bundle (as produced by export_backup). ' +
        'Existing rows are skipped (idempotent). DESTRUCTIVE / high-impact — pass confirm=true.',
      inputSchema: {
        ndjson: z.string().min(1).describe('Raw NDJSON backup content, one JSON object per line.'),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ ndjson }) => run(() => client.postRaw<unknown>('/admin/restore', ndjson)),
  );

  // ── Materialized collections ───────────────────────────────────────────────
  server.registerTool(
    'list_materializations',
    { description: 'List materialized collections (physical tables).', inputSchema: {} },
    async () => run(() => client.get<unknown>('/materialize')),
  );

  server.registerTool(
    'register_materialization',
    {
      description: 'Register a materialized collection and create its physical table.',
      inputSchema: materializeSchema.shape,
    },
    async (input) => run(() => client.post<unknown>('/materialize', input)),
  );

  server.registerTool(
    'refresh_materialization',
    {
      description: 'Refresh a materialized collection (truncate + re-insert from source).',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.post<unknown>(`/materialize/${encodePathSegment(id)}/refresh`, {})),
  );

  server.registerTool(
    'query_materialization',
    {
      description: 'Query the physical table of a materialized collection directly.',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.get<unknown>(`/materialize/${encodePathSegment(id)}/data`)),
  );

  server.registerTool(
    'drop_materialization',
    {
      description: 'Drop a materialized collection (physical table + metadata). DESTRUCTIVE — pass confirm=true.',
      inputSchema: { id: idPathSegmentSchema, confirm: z.literal(true).describe(confirmDescription) },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/materialize/${encodePathSegment(id)}`);
        return okText(`Materialization "${id}" dropped.`);
      }),
  );
}
