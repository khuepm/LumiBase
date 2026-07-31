import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerCrud } from './_crud.js';
import { confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

const presetSchema = z.object({
  bookmark: z.string().nullable().optional(),
  collection: z.string(),
  userId: z.string().nullable().optional(),
  roleId: z.string().nullable().optional(),
  layout: z.string().optional(),
  layoutQuery: z.record(z.string(), z.unknown()).optional(),
  layoutOptions: z.record(z.string(), z.unknown()).optional(),
  search: z.string().nullable().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  refreshInterval: z.number().int().min(0).optional(),
});

const translationSchema = z.object({
  language: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
  status: z.string().optional(),
});

export function registerContentConfigTools(server: McpServer, client: LumiBaseClient) {
  // ── Presets (UI view presets per collection) ──────────────────────────────
  registerCrud(server, client, {
    basePath: '/presets',
    resource: 'preset',
    namePrefix: 'preset',
    listQuery: { collection: z.string().optional() },
    createSchema: presetSchema.shape,
    updateSchema: presetSchema.partial().shape,
  });

  // Resolution endpoints — the effective default view (user > role-chain >
  // global) and the named bookmarks a principal can see for a collection.
  server.registerTool(
    'get_effective_preset',
    {
      description:
        'Resolve the effective default view for a collection (user > role-chain > global precedence).',
      inputSchema: { collection: z.string().min(1) },
    },
    async ({ collection }) =>
      run(() => client.get<unknown>(`/presets/effective?collection=${encodeURIComponent(collection)}`)),
  );

  server.registerTool(
    'list_preset_bookmarks',
    {
      description: 'List the named preset bookmarks visible to the principal for a collection (with scope).',
      inputSchema: { collection: z.string().min(1) },
    },
    async ({ collection }) =>
      run(() => client.get<unknown>(`/presets/bookmarks?collection=${encodeURIComponent(collection)}`)),
  );

  // ── Translations (i18n strings) ───────────────────────────────────────────
  registerCrud(server, client, {
    basePath: '/translations',
    resource: 'translation',
    namePrefix: 'translation',
    listQuery: {
      namespace: z.string().optional(),
      language: z.string().optional(),
    },
    createSchema: translationSchema.shape,
    updateSchema: translationSchema.partial().shape,
  });

  // ── Settings (site-scoped KV config; POST is upsert, keyed by `key`) ───────
  server.registerTool(
    'list_settings',
    {
      description: 'List site settings, optionally filtered by scope.',
      inputSchema: { scope: z.string().optional() },
    },
    async ({ scope }) =>
      run(() => client.get<unknown>(`/settings${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`)),
  );

  server.registerTool(
    'get_setting',
    {
      description: 'Get a single setting by key.',
      inputSchema: { key: idPathSegmentSchema },
    },
    async ({ key }) => run(() => client.get<unknown>(`/settings/${encodePathSegment(key)}`)),
  );

  server.registerTool(
    'upsert_setting',
    {
      description: 'Create or update a setting (upsert by key).',
      inputSchema: {
        key: idPathSegmentSchema,
        value: z.record(z.string(), z.unknown()).describe('Arbitrary JSON value object for the setting.'),
        scope: z.string().optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/settings', input)),
  );

  server.registerTool(
    'delete_setting',
    {
      description: 'Delete a setting by key. DESTRUCTIVE — warn the user first and pass confirm=true.',
      inputSchema: {
        key: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ key }) =>
      run(async () => {
        await client.delete(`/settings/${encodePathSegment(key)}`);
        return okText(`Setting "${key}" deleted.`);
      }),
  );
}
