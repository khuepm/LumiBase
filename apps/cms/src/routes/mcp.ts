import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { isAdminPrincipal } from '../middleware/control-plane-access-guard';
import { auditSecurityGuardDenied } from '../middleware/security-audit';
import { buildAgentNotifier } from '../modules/notifications/notify-context';
import { AccessService } from '../services/access-service';
import { AISecureHarness, CORE_SKILLS, isControlPlaneSkill } from '../services/ai-harness';
import { ConfigService } from '../services/config-service';
import { ExtensionsService } from '../services/extensions-service';
import { getContentOsFlags } from '../services/feature-flags';
import { IntentService } from '../services/intent-service';
import { itemServiceForRequest } from '../services/item-service-factory';
import { createConfiguredLLMProvider } from '../services/llm-provider';
import { McpService, type McpHarnessPort } from '../services/mcp-service';
import { SchemaService } from '../services/schema-service';
import { ToolRegistryService } from '../services/tool-registry-service';

/**
 * MCP server endpoint — Streamable HTTP transport (content-os task 4.1;
 * Req 4.1-4.3). Mounted on the authenticated `api` chain, so the bearer
 * token's roles become the capability set passed to the harness: an MCP
 * client can never do more than the same token could via the Agent API.
 *
 * Gated by the per-site `contentOs.mcp` flag (default off).
 */
export const mcpRouter = new Hono<AppEnv>();

mcpRouter.post('/', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const flags = await getContentOsFlags(db, siteId);
  if (!flags.mcp) {
    return c.json(
      { errors: [{ code: 'MCP_DISABLED', message: 'Enable the contentOs.mcp flag for this site to use the MCP endpoint.' }] },
      404,
    );
  }

  const runtime = c.get('runtime');
  const auth = c.get('auth');
  const llm = createConfiguredLLMProvider(c.env as unknown as Record<string, string | undefined>);
  const registry = new ToolRegistryService(db, siteId, CORE_SKILLS);
  const harness = new AISecureHarness({
    db,
    siteId,
    schemaService: new SchemaService({ db, siteId, cache: runtime.cache }),
    // Request-scoped ItemService so MCP-driven skills enforce the same
    // row/field RBAC as the bearer token would via the Agent API — matching
    // this router's contract that an MCP client "can never do more than the
    // same token could via the Agent API". Previously built without a
    // permissionCtx, which silently bypassed RBAC.
    itemService: itemServiceForRequest(c),
    accessService: new AccessService({ db, siteId, userId: auth.userId ?? null, cache: runtime.cache }),
    intentService: new IntentService({ db, siteId, userId: auth.userId ?? null, llm }),
    configService: new ConfigService({ db, siteId }),
    extensionsService: new ExtensionsService({ db, siteId, userId: auth.userId ?? null }),
    llm,
    queue: runtime.queue,
    notify: buildAgentNotifier(c),
  });

  const port: McpHarnessPort = {
    listTools: async () =>
      (await registry.listTools()).map(({ name, description, inputSchema, enabled }) => ({
        name,
        description,
        inputSchema,
        enabled,
      })),
    execute: (skillName, args, capabilities, contextMessage) =>
      harness.execute(skillName, args, capabilities, contextMessage),
  };

  const body: unknown = await c.req.json().catch(() => undefined);

  // Defense-in-depth admin backstop. The MCP surface is not listed in
  // `CONTROL_PLANE_PATHS`, so `withControlPlaneAccessGuard()` never runs for
  // it; like the Agent API, MCP relies on the harness's in-code capability +
  // HITL checks. This mirrors that guard's intent ("control-plane operations
  // stay behind an admin principal even if the in-code check is later
  // weakened") for the one MCP method that mutates state: a `tools/call`
  // targeting a control-plane skill (dangerous, schema-mutating, or `delete*`)
  // requires an admin principal before the harness ever runs. Discovery
  // (`tools/list`, `initialize`, `ping`) and safe read skills are unaffected,
  // preserving Agent-API parity for everything else.
  const controlPlaneSkill = controlPlaneSkillFromCall(body);
  if (controlPlaneSkill && !isAdminPrincipal(auth)) {
    await auditSecurityGuardDenied(c, 'mcp_control_plane_skill_denied', {
      skill: controlPlaneSkill,
      reason: 'non_admin_control_plane_skill',
      roles: auth?.roles ?? [],
      principalType: auth?.type ?? 'user',
    });
    return c.json(
      {
        errors: [
          {
            code: 'CONTROL_PLANE_FORBIDDEN',
            message: 'Control-plane skills require an admin principal.',
          },
        ],
      },
      403,
    );
  }

  const response = await new McpService(port).handle(body, auth.roles ?? []);
  if (response === null) {
    // Notification — Streamable HTTP answers 202 Accepted with no body.
    return c.body(null, 202);
  }
  return c.json(response);
});

/**
 * If `body` is a JSON-RPC `tools/call` whose target skill is a control-plane
 * operation, returns the skill name; otherwise `null`. Used by the admin
 * backstop above.
 *
 * Resolution uses the static `CORE_SKILLS` metadata (where `dangerous` and
 * `requiredCapabilities` live) plus the name-based `delete*` rule — covering
 * every governed skill. A name absent from `CORE_SKILLS` that does not start
 * with `delete` returns `null` and falls through to the harness, which denies
 * unknown skills anyway, so nothing executes unguarded.
 */
function controlPlaneSkillFromCall(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method !== 'tools/call') return null;
  const name = request.params?.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const skill = CORE_SKILLS[name];
  if (skill) {
    return isControlPlaneSkill(skill, name) ? name : null;
  }
  // Unknown skill: only the name-based `delete*` rule applies.
  return name.startsWith('delete') ? name : null;
}

// The optional SSE stream of the Streamable HTTP transport is not offered;
// clients fall back to plain request/response per the MCP spec.
mcpRouter.get('/', (c) =>
  c.json(
    { errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'This MCP server does not offer a server-initiated stream; POST JSON-RPC messages instead.' }] },
    405,
  ),
);
