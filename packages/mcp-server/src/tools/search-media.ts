import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, confirmDescription, okText, run } from './_shared.js';
import { encodeMediaKey, mediaKeySchema } from './path.js';

export function registerSearchMediaTools(server: McpServer, client: LumiBaseClient) {
  // ── Full-text search ──────────────────────────────────────────────────────
  server.registerTool(
    'search',
    {
      description:
        'Full-text search within a collection. Returns ranked hits from the search backend. ' +
        'The `collection` parameter is required.',
      inputSchema: {
        q: z.string().min(1).describe('Query string.'),
        collection: z.string().min(1).describe('Collection to search.'),
        filter: z.string().optional().describe('Backend filter expression.'),
        sort: z.string().optional().describe('Comma-separated sort fields.'),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/search${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  // ── Media (metadata only — list & delete; binary up/download not exposed) ──
  server.registerTool(
    'list_media',
    {
      description: 'List media asset keys, optionally filtered by key prefix.',
      inputSchema: { prefix: z.string().optional() },
    },
    async ({ prefix }) =>
      run(() => client.get<unknown>(`/media${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`)),
  );

  server.registerTool(
    'delete_media',
    {
      description: 'Delete a media asset by key. DESTRUCTIVE — warn the user first and pass confirm=true.',
      inputSchema: {
        key: mediaKeySchema.describe('Full storage key of the asset.'),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ key }) =>
      run(async () => {
        await client.delete(`/media/${encodeMediaKey(key)}`);
        return okText(`Media asset "${key}" deleted.`);
      }),
  );

  // ── Transform presets (named image-transform recipes for delivery) ────────
  // Read-only: an agent lists the presets so it can reference `?preset=<key>`
  // when embedding a media URL. Signed delivery URLs are built at the edge with
  // a server secret, so no URL-signing tool is exposed here.
  server.registerTool(
    'list_transform_presets',
    {
      description: 'List named image-transform presets available for media delivery (key + DSL).',
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/transform-presets')),
  );
}
