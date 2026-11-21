import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LumiBaseClient, configFromEnv } from './client.js';
import { registerAllTools } from './tools/index.js';
import { registerExtensionTools } from './tools/extension-tools.js';
import { registerPromptForwarding } from './tools/prompts.js';

async function main() {
  const config = configFromEnv();
  const client = new LumiBaseClient(config);

  const server = new McpServer({
    name: 'lumibase',
    version: '0.9.0',
  });

  registerAllTools(server, client, config);
  // Extension tools are per site and installed at runtime (#715): discovered
  // from the governed endpoint, every call forwarded to the harness.
  if (!config.opsOnly) await registerExtensionTools(server, client);
  // Site Skills and extension prompts (#712 B200): discovered from the governed
  // endpoint, every prompts/get forwarded to it.
  if (!config.opsOnly) await registerPromptForwarding(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[lumibase-mcp] Fatal:', err);
  process.exit(1);
});
