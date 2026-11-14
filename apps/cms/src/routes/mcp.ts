import { eq } from 'drizzle-orm';
import { organizations } from '@lumibase/database';
import { systemDbFor } from '../middleware/db';
import { organizationActorFromAuth, resolveOrganizationActorRole } from '../services/organization-operations';
import { OrganizationHarness, organizationMcpEnabled } from '../services/organization-harness';
import { isFrontendAudience } from '../services/auth/token-audience';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { isAdminPrincipal } from '../middleware/control-plane-access-guard';
import { auditSecurityGuardDenied } from '../middleware/security-audit';
import { buildAgentNotifier } from '../modules/notifications/notify-context';
import { AccessService } from '../services/access-service';
import { AISecureHarness, CORE_SKILLS, isControlPlaneSkill, skillCatalog } from '../services/ai-harness';
import { ConfigService } from '../services/config-service';
import { ExtensionsService } from '../services/extensions-service';
import { getContentOsFlags } from '../services/feature-flags';
import { approvalRequesterFromAuth, resolveRequestCapabilities } from '../services/governed-capabilities';
import { IntentService } from '../services/intent-service';
import { itemServiceForRequest, buildRequestPermissionContext } from '../services/item-service-factory';
import { createConfiguredLLMProvider } from '../services/llm-provider';
import { McpService, toolAnnotations, toolTitle, type McpHarnessPort } from '../services/mcp-service';
import { SchemaService } from '../services/schema-service';
import { SiteSkillService } from '../services/site-skill-service';
import { ToolRegistryService } from '../services/tool-registry-service';
import { mcpResourceContext } from '../middleware/mcp-oauth';
import { DECISION_CAPABILITY, satisfiesCapability } from '../services/effective-capability-service';
import { MCP_SCOPES, bearerChallenge, narrowCapabilitiesByScopes, scopesForCapabilities } from '../services/mcp-oauth';

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

/**
 * Every capability string a core skill can require — the universe an OAuth
 * principal's unlimited `admin` marker is expanded into when its scopes do not
 * cover everything (#346). Skills outside `CORE_SKILLS` are then denied for
 * that principal, which is the fail-closed direction.
 */
const CORE_CAPABILITY_UNIVERSE: readonly string[] = [
  ...new Set([
    ...Object.values(CORE_SKILLS).flatMap((skill) => skill.requiredCapabilities),
    DECISION_CAPABILITY,
  ]),
].sort();

/** 403 + RFC 6750 `insufficient_scope` challenge so the client can step up. */
function insufficientScope(c: Context<AppEnv>, scopes: readonly string[]) {
  const ctx = mcpResourceContext(c);
  if (ctx) {
    c.header('WWW-Authenticate', bearerChallenge({ resourceMetadata: ctx.resourceMetadata, error: 'insufficient_scope', scope: scopes }));
  }
  return c.json(
    { errors: [{ code: 'INSUFFICIENT_SCOPE', message: `The access token lacks the scope(s): ${scopes.join(' ')}.`, scope: scopes.join(' ') }] },
    403,
  );
}

async function handleMcp(c: Context<AppEnv>) {
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
    // OAuth connector tokens are site-scoped by construction (the resource URI
    // names a site endpoint); the organization plane is not offered to them.
    if (isFrontendAudience(auth?.raw?.aud) || (auth?.apiKeyId && !orgKey) || auth?.oauth) {
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
  const registry = new ToolRegistryService(db, siteId, skillCatalog());
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

  // Capabilities come from the live RBAC bundle, not from `auth.roles` (#472).
  // `auth.roles` holds a role *id* for a normal user and `[]` for an API key, so
  // comparing it against `items:write` could only ever match the literal
  // `'admin'` string a bootstrap/dev principal gets — the harness was
  // admin-or-nothing regardless of what the token was actually allowed to do.
  const grant = await resolveRequestCapabilities(c);

  // Site playbooks (#712) surface as MCP prompts (#345): an external agent
  // can pull this site's house rules the same way the built-in Copilot gets
  // them. Read-only. Skill bodies are control-plane data — REST serves them
  // only behind `withControlPlaneAccessGuard` — and `/mcp` is not a
  // control-plane path, so the same rule is applied here: only a resolved
  // control-plane admin gets prompts. Anyone else sees an empty list and the
  // same "Unknown prompt" error as for a name that does not exist. The
  // per-skill surface/capability filter still applies on top.
  const siteSkills = new SiteSkillService({ db, siteId });
  const mayReadSkills = grant.allowed && grant.controlPlaneAdmin;
  const promptSkills = async (capabilities: readonly string[]) =>
    mayReadSkills ? siteSkills.listForMcp(capabilities) : [];
  const port: McpHarnessPort = {
    listPrompts: async (capabilities) =>
      (await promptSkills(capabilities)).map((skill) => ({
        name: skill.slug,
        title: skill.name,
        description: skill.description,
      })),
    getPrompt: async (name, capabilities) => {
      const skill = (await promptSkills(capabilities)).find((entry) => entry.slug === name);
      return skill
        ? {
            name: skill.slug,
            title: skill.name,
            description: skill.description,
            text: skill.body,
            version: skill.version,
            hash: skill.hash,
          }
        : null;
    },
    listTools: async () => [
      ...(await registry.listTools())
        // An external-action tool is advertised only to a caller that holds
        // its capability. Listing is not authorization (the harness decides
        // every call), but a tool that reaches a third party should not be
        // discoverable by a token that could never use it.
        .filter((tool) => !tool.external || (grant.allowed && satisfiesCapability(grant.capabilities, tool.external.capability)))
        .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        enabled: tool.enabled,
        title: toolTitle(tool.name),
        annotations: toolAnnotations(tool),
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

  // OAuth scope narrowing (#346). Runs AFTER the backstop above, which is
  // therefore unchanged for OAuth principals; scopes can only take more away.
  let capabilities = grant.capabilities;
  if (auth?.oauth) {
    const scopes = auth.oauth.scopes;
    capabilities = narrowCapabilitiesByScopes(grant.capabilities, scopes, CORE_CAPABILITY_UNIVERSE);
    if (controlPlaneSkill && !scopes.includes(MCP_SCOPES.admin)) {
      return insufficientScope(c, [MCP_SCOPES.admin]);
    }
    // A capability the RBAC grant HAS but the token's scopes removed is a scope
    // problem the client can fix by re-authorizing — say so with a step-up
    // challenge. A capability the grant never had stays a harness denial.
    const skill = calledSkill(body);
    const required = skill ? CORE_SKILLS[skill]?.requiredCapabilities ?? [] : [];
    const scopedOut = required.filter(
      (cap) => satisfiesCapability(grant.capabilities, cap) && !satisfiesCapability(capabilities, cap),
    );
    if (scopedOut.length > 0) return insufficientScope(c, scopesForCapabilities(scopedOut));
  }

  const response = await new McpService(port, { organizationId }).handle(body, capabilities);
  if (response === null) {
    // Notification — Streamable HTTP answers 202 Accepted with no body.
    return c.body(null, 202);
  }
  return c.json(response);
}

mcpRouter.post('/', handleMcp);
// Site-addressed form (#346): the site rides in the path for hosted OAuth
// connectors that cannot send `X-Lumi-Site`. `withTenant` resolves it.
mcpRouter.post('/sites/:siteId', handleMcp);

/** Skill name of a `tools/call`, or `null`. */
function calledSkill(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method !== 'tools/call') return null;
  return typeof request.params?.name === 'string' ? request.params.name : null;
}

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
const noStream = (c: Context<AppEnv>) =>
  c.json(
    { errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'This MCP server does not offer a server-initiated stream; POST JSON-RPC messages instead.' }] },
    405,
  );
mcpRouter.get('/', noStream);
mcpRouter.get('/sites/:siteId', noStream);
