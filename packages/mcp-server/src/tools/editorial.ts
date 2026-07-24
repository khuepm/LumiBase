import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, run } from './_shared.js';
import { collectionNameSchema, encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Editorial workflow tools — the review queue and its state transitions
 * (`apps/cms/src/routes/editorial.ts`). These are RBAC-gated writes, not schema
 * mutations, so they follow the same passthrough model as item CRUD: the
 * bearer token must carry the editorial permission. `approve`/`reject` are
 * consequential publish-gate decisions — the handler descriptions say so.
 */
export function registerEditorialTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_reviews',
    {
      description: 'List the editorial review queue, optionally filtered by status or assignee.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        assignedTo: z.string().max(128).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/editorial/reviews${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  server.registerTool(
    'submit_review',
    {
      description: 'Submit an item for editorial review, optionally assigning a reviewer.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        assignedTo: z.string().min(1).max(128).nullable().optional(),
      },
    },
    async ({ collection, id, assignedTo }) =>
      run(() =>
        client.post<unknown>(
          `/editorial/${encodePathSegment(collection)}/${encodePathSegment(id)}/submit-review`,
          { assignedTo },
        ),
      ),
  );

  server.registerTool(
    'approve_content',
    {
      description: 'Approve an item in editorial review (a publish-gate decision). Optional reason is audited.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ collection, id, reason }) =>
      run(() =>
        client.post<unknown>(
          `/editorial/${encodePathSegment(collection)}/${encodePathSegment(id)}/approve`,
          { reason },
        ),
      ),
  );

  server.registerTool(
    'reject_content',
    {
      description: 'Reject an item in editorial review. Optional reason is audited.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ collection, id, reason }) =>
      run(() =>
        client.post<unknown>(
          `/editorial/${encodePathSegment(collection)}/${encodePathSegment(id)}/reject`,
          { reason },
        ),
      ),
  );
}
