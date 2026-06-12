import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LumiBaseClient, configFromEnv } from './client.js';
import { registerCollectionTools } from './tools/collections.js';
import { registerFieldTools } from './tools/fields.js';
import { registerItemTools } from './tools/items.js';

async function main() {
  const config = configFromEnv();
  const client = new LumiBaseClient(config);

  const server = new McpServer({
    name: 'lumibase',
    version: '0.4.4',
  });

  registerCollectionTools(server, client);
  registerFieldTools(server, client);
  registerItemTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[lumibase-mcp] Fatal:', err);
  process.exit(1);
});
