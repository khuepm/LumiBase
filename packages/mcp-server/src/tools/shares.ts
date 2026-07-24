import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Share-link tools — create and revoke scoped public share links for a single
 * item (`apps/cms/src/routes/shares.ts`, admin router). The public redemption
 * endpoint (`GET /shares/:token`) is unauthenticated and intentionally not
 * exposed here. Revoke requires `confirm` (it invalidates a live link).
 */
export function registerShareTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'create_share',
    {
      description: 'Create a scoped public share link for a single item, viewed through a given role.',
      inputSchema: {
        collection: z.string().min(1),
        itemId: z.string().min(1),
        roleId: z.string().min(1).describe('Role whose permissions the link is viewed through.'),
        password: z.string().min(1).optional(),
        validFrom: z.string().datetime().nullable().optional(),
        validUntil: z.string().datetime().nullable().optional(),
        maxUses: z.number().int().min(1).nullable().optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/shares', input)),
  );

  server.registerTool(
    'revoke_share',
    {
      description: 'Revoke a share link by id. DESTRUCTIVE — warn the user first and pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id }) =>
      run(async () => {
        await client.post<unknown>(`/shares/${encodePathSegment(id)}/revoke`, {});
        return okText(`Share link "${id}" revoked.`);
      }),
  );
}
