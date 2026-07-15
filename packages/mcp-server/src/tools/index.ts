import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LumiBaseClient } from '../client.js';
import { registerAccessTools } from './access.js';
import { registerAdminTools } from './admin.js';
import { registerAgentTools } from './agent.js';
import { registerApiKeyTools } from './api-keys.js';
import { registerCdcTools } from './cdc.js';
import { registerCollectionTools } from './collections.js';
import { registerContentConfigTools } from './content-config.js';
import { registerExtensionTools } from './extensions.js';
import { registerFieldTools } from './fields.js';
import { registerInsightsTools } from './insights.js';
import { registerItemTools } from './items.js';
import { registerOpsTools } from './ops.js';
import { registerPermissionTools } from './permissions.js';
import { registerRelationTools } from './relations.js';
import { registerSearchMediaTools } from './search-media.js';
import { registerTranslationMemoryTools } from './translation-memory.js';
import { registerUsersTeamsTools } from './users-teams.js';
import { registerWebhookTools } from './webhooks.js';

/**
 * Registers every LumiBase tool module on the MCP server. Each module wraps a
 * group of REST endpoints; governance (RBAC, tenancy, feature flags) is enforced
 * server-side by the CMS for the bearer token, so the MCP server stays a thin
 * passthrough.
 */
export function registerAllTools(server: McpServer, client: LumiBaseClient): void {
  // Content & schema
  registerCollectionTools(server, client);
  registerFieldTools(server, client);
  registerItemTools(server, client);
  registerRelationTools(server, client);
  registerContentConfigTools(server, client);
  registerSearchMediaTools(server, client);
  registerTranslationMemoryTools(server, client);
  registerInsightsTools(server, client);

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
}
