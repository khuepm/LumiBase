import { z } from 'zod';
import { registerOrganizationTools } from './organization.js';
import { fail } from './_shared.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';
import { GOVERNED_TOOLS, GovernedDispatcher, isMutationTool } from '../governed.js';
import { registerAccessTools } from './access.js';
import { registerAdminTools } from './admin.js';
import { registerAgentTools } from './agent.js';
import { registerApiKeyTools } from './api-keys.js';
import { registerCdcTools } from './cdc.js';
import { registerCollectionTools } from './collections.js';
import { registerContentConfigTools } from './content-config.js';
import { registerDeploymentTools } from './deployments.js';
import { registerEditorialTools } from './editorial.js';
import { registerExtensionTools } from './extensions.js';
import { registerFieldTools } from './fields.js';
import { registerInsightsTools } from './insights.js';
import { registerItemTools } from './items.js';
import { registerReleaseTools } from './releases.js';
import { registerShareTools } from './shares.js';
import { registerOpsTools } from './ops.js';
import { registerPermissionTools } from './permissions.js';
import { registerRelationTools } from './relations.js';
import { registerSearchMediaTools } from './search-media.js';
import { registerTranslationMemoryTools } from './translation-memory.js';
import { registerUsersTeamsTools } from './users-teams.js';
import { registerWebhookTools } from './webhooks.js';

/**
 * Registers every LumiBase tool module on the MCP server.
 *
 * Each module wraps a group of REST endpoints. RBAC, tenancy and feature flags
 * are enforced server-side for the bearer token either way; what REST does NOT
 * apply is agent governance — autonomy levels, HITL approval, the kill switch and
 * the run audit trail, all of which live in the harness behind
 * `POST /api/v1/mcp`. Tools listed in `GOVERNED_TOOLS` are therefore redirected
 * there (#454); everything else keeps its REST handler.
 *
 * The redirect happens here, once, rather than inside each module: the modules
 * build REST paths and know nothing about skills, and spreading the decision
 * across 24 files is how it would drift.
 */
export function registerAllTools(
  server: McpServer,
  client: LumiBaseClient,
  options: { dispatcher?: GovernedDispatcher | null; tokenKind?: 'site' | 'organization'; siteId?: string; readOnly?: boolean } = {},
): void {
  const tokenKind = options.tokenKind ?? client.tokenKind ?? 'site';
  const siteId = options.siteId ?? client.siteId;
  const readOnly = options.readOnly ?? client.readOnly ?? false;
  const requireSiteArg = tokenKind === 'organization' && !siteId;
  const scoped = withProfile(server, client, { readOnly, requireSiteArg });
  const dispatcher = options.dispatcher === undefined ? new GovernedDispatcher(client) : options.dispatcher;
  const target = dispatcher?.enabled ? withGovernedHandlers(scoped, dispatcher) : scoped;
  registerModules(target, client);
  if (tokenKind === 'organization') {
    // Org handlers have their own mandatory dispatcher and never inherit a site argument.
    registerOrganizationTools(withProfile(server, client, { readOnly, requireSiteArg: false }), client, Boolean(siteId));
  }
}

/**
 * Wraps `registerTool` so a governed tool's handler tries the harness first.
 *
 * The original REST handler is kept and used as the fallback, which is what makes
 * mode `auto` possible without duplicating any endpoint knowledge.
 *
 * ## Why unmapped mutations are refused in mode `on`
 *
 * This wrapper used to leave any tool without a `GOVERNED_TOOLS` entry on its
 * original REST handler, whatever the mode. So `LUMIBASE_MCP_GOVERNED=on` — the
 * setting whose entire purpose is "never execute an ungoverned write" — governed
 * the 27 mapped tools and silently let every other mutation through to REST.
 * `update_collection` reached `PATCH /collections/:name` and reported success
 * without a single JSON-RPC call. REST still applies RBAC and tenant scoping, so
 * this was not an authorization bypass; it bypassed the *governance* layer
 * (autonomy gradient, HITL approval, kill switch, `agent_runs` audit), which is
 * the contract `on` is supposed to guarantee.
 *
 * `UNGOVERNED_MUTATIONS` documented the gap but could not close it: it is a
 * description, not a gate. Mode `on` now refuses at the handler, before the REST
 * call exists, so there is no side effect to undo. Read-only tools are untouched
 * — refusing those would break the transport for no safety gain.
 */
function withGovernedHandlers(server: McpServer, dispatcher: GovernedDispatcher): McpServer {
  return new Proxy(server, {
    get(t, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(t, prop, receiver);
      return (name: string, config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        const binding = GOVERNED_TOOLS[name];
        let wrapped = handler;
        if (binding) {
          wrapped = async (args: Record<string, unknown>) =>
            (await dispatcher.dispatch(name, args, binding)) ?? (await handler(args));
        } else if (dispatcher.requiresGovernance && isMutationTool(name) &&
          !((config as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations?.readOnlyHint === true &&
            (config as { annotations?: { destructiveHint?: boolean } }).annotations?.destructiveHint !== true)) {
          // No `await handler(...)` anywhere in this branch, deliberately: the
          // refusal has to be the whole behaviour, not a message printed after
          // the write already happened.
          wrapped = async () => dispatcher.refuseUngoverned(name);
        }
        return (t as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool(
          name,
          config,
          wrapped,
        );
      };
    },
  });
}

function registerModules(server: McpServer, client: LumiBaseClient): void {
  // Content & schema
  registerCollectionTools(server, client);
  registerFieldTools(server, client);
  registerItemTools(server, client);
  registerRelationTools(server, client);
  registerContentConfigTools(server, client);
  registerSearchMediaTools(server, client);
  registerTranslationMemoryTools(server, client);
  registerInsightsTools(server, client);
  registerEditorialTools(server, client);
  registerReleaseTools(server, client);
  registerShareTools(server, client);

  // Access control & identity
  registerPermissionTools(server, client);
  registerAccessTools(server, client);
  registerApiKeyTools(server, client);
  registerUsersTeamsTools(server, client);

  // Automation & governance
  registerWebhookTools(server, client);
  registerCdcTools(server, client);
  registerAgentTools(server, client);

  // Operations & administration
  registerOpsTools(server, client);
  registerAdminTools(server, client);
  registerExtensionTools(server, client);
  registerDeploymentTools(server, client);
}

function withProfile(server: McpServer, client: LumiBaseClient, profile: { readOnly: boolean; requireSiteArg: boolean }): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        const mutation = isMutationTool(name);
        const annotations = {
          readOnlyHint: !mutation, destructiveHint: /^(delete|remove|revoke|purge|uninstall)_/.test(name),
          ...(config.annotations as Record<string, unknown> | undefined),
        };
        if (profile.readOnly && (annotations.destructiveHint || !annotations.readOnlyHint)) return;
        const inputSchema = { ...(config.inputSchema as Record<string, z.ZodType> ?? {}),
          ...(profile.requireSiteArg ? { site: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) } : {}),
        };
        const wrapped = async (args: Record<string, unknown>) => {
          if (!profile.requireSiteArg) return handler(args);
          const { site, ...rest } = args;
          if (typeof site !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(site)) return fail(new Error('A valid site argument is required'));
          return client.withSite(site, () => handler(rest));
        };
        return (target as unknown as { registerTool: (...args: unknown[]) => unknown })
          .registerTool(name, { ...config, annotations, inputSchema }, wrapped);
      };
    },
  });
}
