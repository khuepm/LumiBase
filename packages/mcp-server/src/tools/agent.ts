import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerCrud } from './_crud.js';
import { run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

/** Same 5-field cron gate as `intentInputSchema` and the canonical `createIntent`. */
const CRON_5_FIELD = /^(\S+\s+){4}\S+$/;

// `rules` bounds and the cron pattern mirror `intentInputSchema` (REST) and the
// canonical `createIntent` contract; without them the advertised schema accepted
// `rules: []` and `schedule: "x"`, which both servers refuse (#716).
const intentSchema = z.object({
  name: z.string().min(1).max(120),
  collection: z.string().min(1).max(120),
  rules: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(50)
    .describe('SLO rules (required_fields, freshness, translations, link_health, …).'),
  schedule: z
    .string()
    .regex(CRON_5_FIELD, 'schedule must be a 5-field cron expression')
    .describe('5-field cron expression for reconciliation cadence.'),
  budget: z.record(z.string(), z.unknown()).optional(),
  autonomyCap: z.number().int().min(0).max(4).optional().describe('Max autonomy level L0–L4 for this intent.'),
  maintenanceWindow: z.record(z.string(), z.unknown()).nullable().optional(),
});

const flowNode = z.object({
  id: z.string(),
  key: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  next: z.string().nullable().optional(),
  onError: z.string().nullable().optional(),
  // Explicit branches (J10, #517): branch key → node id, null ends the run.
  // Accepted by REST `flowSchema` and the canonical `createFlow`; missing here,
  // so `update_flow` stripped them (#716 review).
  branches: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.string().nullable()).optional(),
});

const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'draft']).optional(),
  triggerType: z.enum(['webhook', 'event', 'schedule', 'manual']),
  triggerOptions: z.record(z.string(), z.unknown()).optional(),
  graph: z.object({
    entry: z.string().optional(),
    nodes: z.array(flowNode).optional(),
  }),
});

export function registerAgentTools(server: McpServer, client: LumiBaseClient) {
  // ── Content intents (SLOs) — mounted at /agent/intents ─────────────────────
  registerCrud(server, client, {
    basePath: '/agent/intents',
    resource: 'intent',
    namePrefix: 'intent',
    createSchema: intentSchema.shape,
    updateSchema: intentSchema.partial().shape,
  });

  server.registerTool(
    'pause_intent',
    { description: 'Pause an intent (stops scheduled reconciliation).', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.post<unknown>(`/agent/intents/${encodePathSegment(id)}/pause`, {})),
  );

  server.registerTool(
    'resume_intent',
    { description: 'Resume a paused intent.', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.post<unknown>(`/agent/intents/${encodePathSegment(id)}/resume`, {})),
  );

  server.registerTool(
    'list_intent_drifts',
    { description: 'List detected drifts (intent violations) for an intent.', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.get<unknown>(`/agent/intents/${encodePathSegment(id)}/drifts`)),
  );

  server.registerTool(
    'scan_intent',
    { description: 'Trigger an on-demand drift scan for an intent.', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.post<unknown>(`/agent/intents/${encodePathSegment(id)}/scan`, {})),
  );

  server.registerTool(
    'compile_intent',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description: 'Compile a natural-language description into structured intent rules (preview, does not persist).',
      inputSchema: {
        description: z.string().min(1).max(4000),
        collection: z.string().min(1).max(120),
      },
    },
    async (input) => run(() => client.post<unknown>('/agent/intents/compile', input)),
  );

  // ── Flows — mounted at /flows ──────────────────────────────────────────────
  registerCrud(server, client, {
    basePath: '/flows',
    resource: 'flow',
    namePrefix: 'flow',
    createSchema: flowSchema.shape,
    updateSchema: flowSchema.partial().shape,
  });

  server.registerTool(
    'run_flow',
    {
      description: 'Trigger a manual run of a flow with an optional input payload.',
      inputSchema: {
        id: idPathSegmentSchema,
        input: z.record(z.string(), z.unknown()).optional().describe('Initial context passed to the flow.'),
      },
    },
    async ({ id, input }) => run(() => client.post<unknown>(`/flows/${encodePathSegment(id)}/run`, input ?? {})),
  );

  server.registerTool(
    'list_flow_runs',
    { description: 'List recent runs of a flow.', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.get<unknown>(`/flows/${encodePathSegment(id)}/runs`)),
  );

  server.registerTool(
    'get_flow_run',
    {
      description: 'Get a single flow run by id (status, per-step results, error) for diagnosis.',
      inputSchema: { id: idPathSegmentSchema, runId: idPathSegmentSchema },
    },
    async ({ id, runId }) =>
      run(() => client.get<unknown>(`/flows/${encodePathSegment(id)}/runs/${encodePathSegment(runId)}`)),
  );
}
