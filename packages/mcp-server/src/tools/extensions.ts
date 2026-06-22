import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, confirmDescription, okText, run } from './_shared.js';

const EXTENSION_TYPES = ['interface', 'display', 'layout', 'panel', 'module', 'hook', 'endpoint'] as const;

const extensionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_:-]+$/).optional(),
  name: z.string().min(1),
  version: z.string().min(1),
  type: z.enum(EXTENSION_TYPES),
  enabled: z.boolean().optional(),
  bundleUrl: z.string().min(1).describe('https:, http:, or data:text/javascript bundle URL.'),
  manifest: z.record(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
});

export function registerExtensionTools(server: McpServer, client: LumiBaseClient) {
  // ── Installed extensions ───────────────────────────────────────────────────
  server.registerTool(
    'list_extensions',
    { description: 'List extensions installed on the active site.', inputSchema: {} },
    async () => run(() => client.get<unknown>('/extensions')),
  );

  server.registerTool(
    'install_extension',
    {
      description: 'Install (register) an extension on the active site from a bundle URL.',
      inputSchema: extensionSchema.shape,
    },
    async (input) => run(() => client.post<unknown>('/extensions', input)),
  );

  server.registerTool(
    'update_extension',
    {
      description: 'Update an installed extension (enable/disable, version, config). Partial PATCH.',
      inputSchema: { id: z.string().min(1), ...extensionSchema.partial().shape },
    },
    async ({ id, ...patch }) => run(() => client.patch<unknown>(`/extensions/${id}`, patch)),
  );

  server.registerTool(
    'uninstall_extension',
    {
      description: 'Uninstall an extension from the site. DESTRUCTIVE — pass confirm=true.',
      inputSchema: { id: z.string().min(1), confirm: z.literal(true).describe(confirmDescription) },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/extensions/${id}`);
        return okText(`Extension "${id}" uninstalled.`);
      }),
  );

  // ── Marketplace ────────────────────────────────────────────────────────────
  server.registerTool(
    'list_marketplace_extensions',
    {
      description: 'Browse the published extension marketplace.',
      inputSchema: {
        q: z.string().optional(),
        category: z.string().optional(),
        tags: z.string().optional().describe('Comma-separated tags.'),
        sort: z.string().optional(),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/marketplace/extensions${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  server.registerTool(
    'get_marketplace_extension',
    {
      description: 'Get a single marketplace extension by slug.',
      inputSchema: { slug: z.string().min(1) },
    },
    async ({ slug }) => run(() => client.get<unknown>(`/marketplace/extensions/${slug}`)),
  );

  server.registerTool(
    'list_marketplace_updates',
    { description: 'List available updates for installed marketplace extensions.', inputSchema: {} },
    async () => run(() => client.get<unknown>('/marketplace/updates')),
  );

  server.registerTool(
    'install_marketplace_extension',
    {
      description: 'Install a published marketplace extension onto the active site by slug.',
      inputSchema: { slug: z.string().min(1) },
    },
    async ({ slug }) => run(() => client.post<unknown>(`/marketplace/extensions/${slug}/install`, {})),
  );

  server.registerTool(
    'publish_extension',
    {
      description: 'Publish an extension to the marketplace (signs + marks it published).',
      inputSchema: {
        extensionId: z.string().min(1),
        marketplaceSlug: z.string().min(1),
        publisher: z.record(z.unknown()).optional(),
        signature: z.string().optional(),
        signatureAlg: z.string().optional(),
        publisherKeyId: z.string().optional(),
        bundleSha256: z.string().optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/marketplace/publish', input)),
  );
}
