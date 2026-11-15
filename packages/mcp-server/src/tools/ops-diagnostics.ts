import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, run } from './_shared.js';
import { encodePathSegment } from './path.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/**
 * Read-only ops diagnostics (`/api/v1/ops/*`, `.kiro/specs/ops-diagnostics`).
 *
 * Authenticated with LUMIBASE_OPS_TOKEN, never the site API key, and never
 * site-scoped: they diagnose the deployment, not a tenant's content. Registered
 * only when the MCP server has an ops token.
 */
export function registerOpsDiagnosticsTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'ops_diagnostics',
    {
      description:
        'Diagnose the LumiBase deployment: release (version + git sha), pending migrations vs the deployed code, ' +
        'schema drift (tables/columns the code selects that the DB lacks), RLS flag/role/policy coherence, ' +
        'service health, and a sorted list of typed findings (code, severity, message, fix). ' +
        'Start here for any production failure.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => run(() => client.opsGet<unknown>('/diagnostics')),
  );

  server.registerTool(
    'ops_list_errors',
    {
      description:
        'List recent captured 5xx errors (newest first, 14-day retention): request id, path, status, site, ' +
        'release, response error code, and the sanitized error chain incl. Postgres SQLSTATE. ' +
        'No query params, row values or tokens are stored.',
      inputSchema: {
        since: z.string().datetime({ offset: true }).optional().describe('ISO timestamp lower bound'),
        status: z.number().int().min(500).max(599).optional(),
        path: z.string().max(512).optional().describe('Path prefix, e.g. /api/v1/site'),
        siteId: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() =>
        client.opsGet<unknown>(`/errors${buildQs(args as Record<string, string | number | undefined>)}`),
      ),
  );

  server.registerTool(
    'ops_get_error',
    {
      description:
        'Get the captured error(s) for one request id — the `requestId` from a 500 response body or the ' +
        '`x-request-id` response header.',
      inputSchema: { requestId: z.string().min(1).max(128) },
      annotations: READ_ONLY,
    },
    async ({ requestId }) => run(() => client.opsGet<unknown>(`/errors/${encodePathSegment(requestId)}`)),
  );

  server.registerTool(
    'ops_probe_site',
    {
      description:
        'Probe one site the way GET /api/v1/site reads it: does the row exist (system role), can the request ' +
        'connection see it under the current RLS mode, can it under the site RLS scope, does the statement fail ' +
        '(sanitized error + SQLSTATE), and member count. Returns booleans/counts only, never row values.',
      inputSchema: { siteId: z.string().min(1).max(128) },
      annotations: READ_ONLY,
    },
    async ({ siteId }) => run(() => client.opsGet<unknown>(`/sites/${encodePathSegment(siteId)}/probe`)),
  );
}
