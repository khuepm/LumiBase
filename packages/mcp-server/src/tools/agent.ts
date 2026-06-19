import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerCrud } from './_crud.js';
import { run } from './_shared.js';

const intentSchema = z.object({
  name: z.string().min(1).max(120),
  collection: z.string().min(1).max(120),
  rules: z
    .array(z.record(z.unknown()))
    .describe('SLO rules (required_fields, freshness, translations, link_health, …).'),
  schedule: z.string().describe('5-field cron expression for reconciliation cadence.'),
  budget: z.record(z.unknown()).optional(),
  autonomyCap: z.number().int().min(0).max(4).optional().describe('Max autonomy level L0–L4 for this intent.'),
  maintenanceWindow: z.record(z.unknown()).nullable().optional(),
});

const flowNode = z.object({
  id: z.string(),
  key: z.string(),
  options: z.record(z.unknown()).optional(),
  next: z.string().nullable().optional(),
  onError: z.string().nullable().optional(),
});

const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'draft']).optional(),
  triggerType: z.enum(['webhook', 'event', 'schedule', 'manual']),
  triggerOptions: z.record(z.unknown()).optional(),
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
    { description: 'Pause an intent (stops scheduled reconciliation).', inputSchema: { id: z.string().min(1) } },
    async ({ id }) => run(() => client.post<unknown>(`/agent/intents/${id}/pause`, {})),
  );

  server.registerTool(
    'resume_intent',
    { description: 'Resume a paused intent.', inputSchema: { id: z.string().min(1) } },
    async ({ id }) => run(() => client.post<unknown>(`/agent/intents/${id}/resume`, {})),
  );

  server.registerTool(
    'list_intent_drifts',
    { description: 'List detected drifts (intent violations) for an intent.', inputSchema: { id: z.string().min(1) } },
    async ({ id }) => run(() => client.get<unknown>(`/agent/intents/${id}/drifts`)),
  );

  server.registerTool(
    'scan_intent',
    { description: 'Trigger an on-demand drift scan for an intent.', inputSchema: { id: z.string().min(1) } },
    async ({ id }) => run(() => client.post<unknown>(`/agent/intents/${id}/scan`, {})),
  );

  server.registerTool(
    'compile_intent',
    {
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
        id: z.string().min(1),
        input: z.record(z.unknown()).optional().describe('Initial context passed to the flow.'),
      },
    },
    async ({ id, input }) => run(() => client.post<unknown>(`/flows/${id}/run`, input ?? {})),
  );

  server.registerTool(
    'list_flow_runs',
    { description: 'List recent runs of a flow.', inputSchema: { id: z.string().min(1) } },
    async ({ id }) => run(() => client.get<unknown>(`/flows/${id}/runs`)),
  );
}
