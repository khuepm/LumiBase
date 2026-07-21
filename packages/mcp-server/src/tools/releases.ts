import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Content release tools — batched, optionally-scheduled publishing
 * (`apps/cms/src/routes/releases.ts`). CRUD plus `publish_release`. All are
 * RBAC-gated passthrough; `delete_release` requires `confirm`. Publishing is a
 * forward, reversible (per-item revisions) action, so it follows the same
 * no-confirm convention as `run_flow`.
 */

const releaseItemSchema = z.object({
  collection: z.string().min(1),
  itemId: z.string().min(1),
  targetStatus: z.enum(['draft', 'published', 'archived']).optional(),
  revisionId: z.string().nullable().optional(),
});

export function registerReleaseTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_releases',
    {
      description: 'List content releases for the site, optionally filtered by status.',
      inputSchema: {
        status: z.string().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/releases${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  server.registerTool(
    'get_release',
    {
      description: 'Get a single content release by id (with its staged items).',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.get<unknown>(`/releases/${encodePathSegment(id)}`)),
  );

  server.registerTool(
    'create_release',
    {
      description: 'Create a content release. Set publishAt for a scheduled release; omit for a manual one.',
      inputSchema: {
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        atomicityMode: z.enum(['all_or_nothing', 'best_effort']).optional(),
        publishAt: z.string().nullable().optional().describe('ISO datetime to auto-publish, or null.'),
      },
    },
    async (input) => run(() => client.post<unknown>('/releases', input)),
  );

  server.registerTool(
    'update_release',
    {
      description: 'Update a release and/or stage/unstage items (partial PATCH).',
      inputSchema: {
        id: idPathSegmentSchema,
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        atomicityMode: z.enum(['all_or_nothing', 'best_effort']).optional(),
        publishAt: z.string().nullable().optional(),
        addItems: z.array(releaseItemSchema).optional().describe('Items to stage into the release.'),
        removeItems: z
          .array(z.object({ collection: z.string(), itemId: z.string() }))
          .optional()
          .describe('Items to unstage.'),
      },
    },
    async ({ id, ...patch }) =>
      run(() => client.patch<unknown>(`/releases/${encodePathSegment(id)}`, patch)),
  );

  server.registerTool(
    'publish_release',
    {
      description: 'Publish a release now (applies every staged item’s target status per the atomicity mode).',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.post<unknown>(`/releases/${encodePathSegment(id)}/publish`, {})),
  );

  server.registerTool(
    'delete_release',
    {
      description: 'Delete a content release. DESTRUCTIVE — warn the user first and pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/releases/${encodePathSegment(id)}`);
        return okText(`Release "${id}" deleted.`);
      }),
  );
}
