import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { buildAgentNotifier } from '../modules/notifications/notify-context';
import { AccessService } from '../services/access-service';
import { AISecureHarness, CORE_SKILLS } from '../services/ai-harness';
import { ConfigService } from '../services/config-service';
import { ExtensionsService } from '../services/extensions-service';
import { getContentOsFlags } from '../services/feature-flags';
import { IntentService } from '../services/intent-service';
import { ItemService } from '../services/item-service';
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
    itemService: new ItemService({
      db,
      siteId,
      userId: auth.userId ?? null,
      cache: runtime.cache,
      search: runtime.search,
      queue: runtime.queue,
    }),
    accessService: new AccessService({ db, siteId, userId: auth.userId ?? null }),
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
  const response = await new McpService(port).handle(body, auth.roles ?? []);
  if (response === null) {
    // Notification — Streamable HTTP answers 202 Accepted with no body.
    return c.body(null, 202);
  }
  return c.json(response);
});

// The optional SSE stream of the Streamable HTTP transport is not offered;
// clients fall back to plain request/response per the MCP spec.
mcpRouter.get('/', (c) =>
  c.json(
    { errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'This MCP server does not offer a server-initiated stream; POST JSON-RPC messages instead.' }] },
    405,
  ),
);
