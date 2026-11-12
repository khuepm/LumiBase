import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CdcReplaySchema, CdcSubscriptionPatchSchema } from '@lumibase/contracts';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerCrud } from './_crud.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Change Feed tools (spec cdc-extension-integration, Req 7.8 / task 12.3).
 *
 * Pure REST passthrough via LumiBaseClient — every call inherits the route's
 * auth/tenant chain, the `cdc:subscribe` capability guard, and the HITL
 * classification of the underlying skill surface. An MCP agent can never do
 * more than its bearer token could do against `/api/v1/cdc/*` directly.
 */

const subscriptionSchema = z.object({
  name: z.string().min(1).max(128),
  kind: z.enum(['pull', 'webhook', 'extension']),
  // `min(1)` items: the REST `CdcSubscriptionCreateSchema` refuses `[""]` (#716 review).
  collections: z.array(z.string().min(1)).optional().describe('Collections to include; empty = all.'),
  operations: z
    .array(z.enum(['create', 'update', 'delete']))
    .optional()
    .describe('Operations to include; empty = all.'),
  payload_mode: z
    .enum(['reference', 'snapshot'])
    .optional()
    .describe('reference = ids only (consumer re-fetches); snapshot = masked data inline.'),
  // `min(1)`: the canonical `createCdcSubscription` refuses an empty id (#716).
  webhook_id: z.string().min(1).optional().describe('Required for kind=webhook (must have a secret).'),
  extension_name: z.string().min(1).optional().describe('Required for kind=extension.'),
});

/**
 * `PATCH /cdc/subscriptions/:id` validates with `CdcSubscriptionPatchSchema`;
 * advertise exactly its keys. Deriving the update from the create schema
 * advertised `kind`, `webhook_id` and `extension_name` (immutable: the PATCH
 * strips them, so the call "succeeded" without effect) and lacked `status`, the
 * only way to pause or resume a subscription (#716 review).
 */
const subscriptionPatchShape = {
  ...CdcSubscriptionPatchSchema.shape,
  status: CdcSubscriptionPatchSchema.shape.status.describe('active | paused — pause or resume delivery.'),
};

export function registerCdcTools(server: McpServer, client: LumiBaseClient) {
  registerCrud(server, client, {
    basePath: '/cdc/subscriptions',
    resource: 'CDC change-feed subscription',
    namePrefix: 'cdc_subscription',
    createSchema: subscriptionSchema.shape,
    updateSchema: subscriptionPatchShape,
  });

  server.registerTool(
    'cdc_events_read',
    {
      description:
        'Read the change feed (keyset pagination). Pass the previous meta.nextCursor to continue; filter by collections/operations CSV.',
      inputSchema: {
        cursor: z.string().optional().describe('Opaque cursor from meta.nextCursor.'),
        collections: z.string().optional().describe('CSV of collections to include.'),
        operations: z.string().optional().describe('CSV of create,update,delete.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.cursor) params.set('cursor', args.cursor);
      if (args.collections) params.set('collections', args.collections);
      if (args.operations) params.set('operations', args.operations);
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const result = await client.get(`/cdc/events${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'cdc_subscription_replay',
    {
      description:
        'Rewind a subscription checkpoint inside the retention window (resets dead/stale back to active).',
      inputSchema: {
        subscription_id: idPathSegmentSchema.describe('Subscription id.'),
        // The route's `CdcReplaySchema` constraints JSON Schema can carry (ISO
        // datetime; non-empty cursor). Two it cannot — exactly one of the two
        // keys, and a cursor that decodes — are left to the route to report.
        occurred_after: CdcReplaySchema.shape.occurred_after.describe(
          'ISO timestamp to rewind to (within retention). Exactly one of occurred_after / cursor.',
        ),
        cursor: z.string().min(1).optional().describe('Exact cursor token to rewind to (from meta.nextCursor).'),
      },
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.cursor) body.cursor = args.cursor;
      if (args.occurred_after) body.occurred_after = args.occurred_after;
      const result = await client.post(
        `/cdc/subscriptions/${encodePathSegment(args.subscription_id)}/replay`,
        body,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
