import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Insights tools — read-only aggregate queries over dashboards and panels.
 * Mounted at `/dashboards` on the CMS (see `apps/cms/src/routes/insights.ts`).
 *
 * These are the "ask the data a question" tools: an agent can list saved
 * dashboards, run a stored panel, or fire an ad-hoc aggregate query without a
 * saved panel. All are non-mutating (the POST tools only execute queries), so
 * they carry the token's read permissions and never enter the HITL approval
 * path. Aggregation is capped and field-whitelisted server-side by
 * `InsightsService`, so query injection is not reachable from here.
 *
 * The panel-query shape mirrors `panelQuerySchema` in `@lumibase/contracts`; it is
 * re-declared locally because this package ships standalone (zod + the MCP SDK
 * only). Cross-field validation ("field required for non-count aggregates") is
 * enforced authoritatively by the CMS, which returns a VALIDATION error the
 * client surfaces — so it is intentionally not duplicated here.
 */

const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;

const dateRangeSchema = z
  .object({
    field: z.string().min(1),
    gte: z.string().optional(),
    lte: z.string().optional(),
    preset: z.string().optional(),
  })
  .describe('Restrict the query to a date window on the given field.');

/** Raw shape for an aggregate query — mirrors shared `panelQuerySchema`. */
const panelQueryShape = {
  collection: z.string().min(1),
  aggregate: z
    .enum(AGGREGATES)
    .describe('Aggregate function. `field` is required for everything except `count`.'),
  field: z.string().min(1).optional().describe('Field to aggregate (required unless aggregate=count).'),
  groupBy: z.string().min(1).optional().describe('Field to group rows by (produces a series).'),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Directus-style condition rule, e.g. { status: { _eq: "published" } }.'),
  dateRange: dateRangeSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional().describe('Max grouped rows to return (default 50).'),
} as const;

export function registerInsightsTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_dashboards',
    {
      description: 'List insight dashboards for the current site.',
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/dashboards')),
  );

  server.registerTool(
    'get_dashboard',
    {
      description: 'Get a single dashboard by id.',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.get<unknown>(`/dashboards/${encodePathSegment(id)}`)),
  );

  server.registerTool(
    'list_dashboard_panels',
    {
      description: 'List the panels of a dashboard (their definitions, not the computed data).',
      inputSchema: { id: idPathSegmentSchema },
    },
    async ({ id }) => run(() => client.get<unknown>(`/dashboards/${encodePathSegment(id)}/panels`)),
  );

  server.registerTool(
    'run_panel',
    {
      description:
        'Run a saved panel and return its computed result. Optionally override the panel’s filter or date range for this run only (does not modify the panel).',
      inputSchema: {
        dashboardId: idPathSegmentSchema,
        panelId: idPathSegmentSchema,
        filter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Override the panel filter for this run (Directus-style condition rule).'),
        dateRange: dateRangeSchema.optional().describe('Override the panel date range for this run.'),
      },
    },
    async ({ dashboardId, panelId, filter, dateRange }) => {
      const override: Record<string, unknown> = {};
      if (filter !== undefined) override['filter'] = filter;
      if (dateRange !== undefined) override['dateRange'] = dateRange;
      return run(() =>
        client.post<unknown>(
          `/dashboards/${encodePathSegment(dashboardId)}/panels/${encodePathSegment(panelId)}/data`,
          override,
        ),
      );
    },
  );

  server.registerTool(
    'query_insights',
    {
      description:
        'Ad-hoc aggregate query over a collection — no saved panel required. Answers operational questions (counts, sums, averages, breakdowns) directly. Read-only.',
      inputSchema: {
        dashboardId: idPathSegmentSchema.describe(
          'Any dashboard id you can access; the query runs ad-hoc and does not read that dashboard.',
        ),
        ...panelQueryShape,
      },
    },
    async ({ dashboardId, ...query }) =>
      run(() =>
        client.post<unknown>(`/dashboards/${encodePathSegment(dashboardId)}/panels/preview`, query),
      ),
  );
}
