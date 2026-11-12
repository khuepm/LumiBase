import { eq } from 'drizzle-orm';
import { organizations } from '@lumibase/database';
import { systemDbFor } from '../middleware/db';
import { organizationActorFromAuth, resolveOrganizationActorRole } from '../services/organization-operations';
import { OrganizationHarness, organizationMcpEnabled } from '../services/organization-harness';
import { isFrontendAudience } from '../services/auth/token-audience';
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
import { approvalRequesterFromAuth, resolveRequestCapabilities } from '../services/governed-capabilities';
import { IntentService } from '../services/intent-service';
import { itemServiceForRequest, buildRequestPermissionContext } from '../services/item-service-factory';
import { createConfiguredLLMProvider } from '../services/llm-provider';
import { McpService, type McpHarnessPort } from '../services/mcp-service';
import { SchemaService } from '../services/schema-service';
import { ToolRegistryService } from '../services/tool-registry-service';

/**
 * MCP server endpoint — Streamable HTTP transport (content-os task 4.1;
 * Req 4.1-4.3). Mounted on the authenticated `api` chain. The capability set
 * passed to the harness is resolved from the bearer token's live RBAC bundle
 * (#472), so an MCP client can never do more than the same token could through
 * REST — and no less either, which is what `auth.roles` used to get wrong.
 *
 * Gated by the per-site `contentOs.mcp` flag (default off).
 */
export const mcpRouter = new Hono<AppEnv>();

mcpRouter.post('/', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const body: unknown = await c.req.json().catch(() => undefined);
  const call = body as { method?: string; params?: { name?: unknown; arguments?: { organizationId?: unknown } } } | null;
  const orgCall = call?.method === 'tools/call' && typeof call.params?.name === 'string' && call.params.name.startsWith('org:');
  const orgKey = auth?.apiKey?.scope === 'organization';
  let organizationId: string | undefined = orgKey && typeof auth.apiKey?.organizationId === 'string'
    ? auth.apiKey.organizationId : undefined;
  let organizationPort: OrganizationHarness | undefined;
  // Site tools on a pinned organization key obey the site's MCP flag. The
  // organization flag gates only organization tools (and the unpinned profile).
  if (orgCall || (orgKey && !siteId)) {
    if (isFrontendAudience(auth?.raw?.aud) || (auth?.apiKeyId && !orgKey)) {
      await auditSecurityGuardDenied(c, 'organization_access_denied', { reason: 'site_scoped_credential_on_org_plane' });
      return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN' }] }, 403);
    }
    const target = orgKey ? auth.apiKey?.organizationId : call?.params?.arguments?.organizationId;
    if (typeof target !== 'string') return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
    organizationId = target;
    const authorizationDb = systemDbFor(c);
    const requester = organizationActorFromAuth(auth);
    const role = await resolveOrganizationActorRole(authorizationDb, target, requester);
    if (!role) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
    const [org] = await authorizationDb.select().from(organizations).where(eq(organizations.id, target)).limit(1);
    if (!org || !organizationMcpEnabled(org.settings, c.env)) {
      return c.json({ errors: [{ code: 'MCP_DISABLED', message: 'Enable contentOs.mcp.allowOrganizationTools for this organization.' }] }, 404);
    }
    organizationPort = new OrganizationHarness({ db: authorizationDb, organizationId: target, requester,
      env: c.env, runtime: c.get('runtime'), requestId: c.get('requestId'), actorEmail: auth.email });
    if (orgCall || !siteId) {
      const response = await new McpService(organizationPort, { organizationId: target }).handle(body, []);
      return response === null ? c.body(null, 202) : c.json(response);
    }
  }
  const flags = await getContentOsFlags(db, siteId);
  if (!flags.mcp) {
    return c.json(
      { errors: [{ code: 'MCP_DISABLED', message: 'Enable the contentOs.mcp flag for this site to use the MCP endpoint.' }] },
      404,
    );
  }

  const runtime = c.get('runtime');
  const llm = createConfiguredLLMProvider(c.env as unknown as Record<string, string | undefined>);
  const registry = new ToolRegistryService(db, siteId, CORE_SKILLS);
  const harness = new AISecureHarness({
    db,
    siteId,
    organizationId,
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
    extensionsService: new ExtensionsService({
      db, siteId, userId: auth.userId ?? null, cache: runtime.cache, env: c.env,
      permissionCtx: buildRequestPermissionContext({ auth, siteId, headers: c.req.header(), ip: c.get('ip') ?? null }),
    }),
    llm,
    queue: runtime.queue,
    notify: buildAgentNotifier(c),
    // Deployment skills are part of the MCP tool surface; the KeyProvider is
    // what lets them decrypt target tokens (capabilities still gate access).
    keys: runtime.keys,
    cache: runtime.cache,
  });

  const port: McpHarnessPort = {
    listTools: async () => [
      ...(await registry.listTools()).map(({ name, description, inputSchema, enabled }) => ({
        name,
        description,
        inputSchema,
        enabled,
      })),
      ...(organizationPort ? (await organizationPort.listTools()).filter((tool) => tool.name === 'org:get_organization' || tool.name === 'org:list_sites') : []),
    ],
    execute: (skillName, args, capabilities, contextMessage) =>
      harness.execute(skillName, args, capabilities, contextMessage, {
        // Provenance for anything this call parks (#472), so approving it later
        // re-reads the caller's grant instead of trusting the decider's.
        requestId: c.get('requestId'),
        requestedByPrincipal: approvalRequesterFromAuth(c.get('auth'), siteId),
      }),
  };

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
  // Capabilities come from the live RBAC bundle, not from `auth.roles` (#472).
  // `auth.roles` holds a role *id* for a normal user and `[]` for an API key, so
  // comparing it against `items:write` could only ever match the literal
  // `'admin'` string a bootstrap/dev principal gets — the harness was
  // admin-or-nothing regardless of what the token was actually allowed to do.
  const grant = await resolveRequestCapabilities(c);

  const controlPlaneSkill = controlPlaneSkillFromCall(body);
  // The backstop now accepts either signal. `isAdminPrincipal` is kept because
  // it is the same predicate `withControlPlaneAccessGuard` uses elsewhere, and
  // `controlPlaneAdmin` is added because it is DB-derived: a real `adminAccess`
  // role passes, while an admin-policy API KEY still does not
  // (`EffectiveCapabilityService.resolveApiKey` returns `controlPlaneAdmin:
  // false` deliberately).
  if (controlPlaneSkill && !isAdminPrincipal(auth) && !grant.controlPlaneAdmin) {
    await auditSecurityGuardDenied(c, 'mcp_control_plane_skill_denied', {
      skill: controlPlaneSkill,
      reason: 'non_admin_control_plane_skill',
      roles: auth?.roles ?? [],
      principalType: auth?.type ?? 'user',
      capabilityCode: grant.code ?? null,
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

  const response = await new McpService(port, { organizationId }).handle(body, grant.capabilities);
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
  if (name.startsWith('org:')) return name;
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
