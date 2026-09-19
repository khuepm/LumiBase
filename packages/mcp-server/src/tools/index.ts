import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';
import { GOVERNED_TOOLS, GovernedDispatcher } from '../governed.js';
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
  options: { dispatcher?: GovernedDispatcher | null } = {},
): void {
  const dispatcher =
    options.dispatcher === undefined ? new GovernedDispatcher(client) : options.dispatcher;
  const target = dispatcher?.enabled ? withGovernedHandlers(server, dispatcher) : server;
  registerModules(target, client);
}

/**
 * Wraps `registerTool` so a governed tool's handler tries the harness first.
 *
 * The original REST handler is kept and used as the fallback, which is what makes
 * mode `auto` possible without duplicating any endpoint knowledge.
 */
function withGovernedHandlers(server: McpServer, dispatcher: GovernedDispatcher): McpServer {
  return new Proxy(server, {
    get(t, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(t, prop, receiver);
      return (name: string, config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        const binding = GOVERNED_TOOLS[name];
        const wrapped = binding
          ? async (args: Record<string, unknown>) =>
              (await dispatcher.dispatch(name, args, binding)) ?? (await handler(args))
          : handler;
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
