import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Deployment tools — READ-ONLY (`apps/cms/src/routes/deployments.ts`).
 *
 * Triggering a build is an outward-facing side effect on an external host, so
 * it is classified `dangerous` and exposed only as a governed harness skill
 * (`triggerDeployment`, HITL below autopilot). The stdio passthrough has no
 * HITL, so it surfaces only the read endpoints — enough for an agent to inspect
 * targets and diagnose a failed build, never to trigger one.
 */
export function registerDeploymentTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_deployment_targets',
    {
      description: 'List configured deployment targets (Vercel/Netlify connections) for the site.',
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/deployments/targets')),
  );

  server.registerTool(
    'list_deployments',
    {
      description: 'List recent deployments, optionally filtered by target or status.',
      inputSchema: {
        targetId: z.string().optional(),
        status: z.string().optional().describe('queued | building | ready | error | canceled.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/deployments${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  server.registerTool(
    'get_deployment',
    {
      description: 'Get a single deployment’s status and details by id.',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.get<unknown>(`/deployments/${encodePathSegment(id)}`)),
  );

  server.registerTool(
    'get_deployment_logs',
    {
      description: 'Fetch the build/deploy logs for a deployment (for diagnosing a failed build).',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.get<unknown>(`/deployments/${encodePathSegment(id)}/logs`)),
  );
}
