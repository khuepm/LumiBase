import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LumiBaseClient, configFromEnv } from './client.js';
import { registerAllTools } from './tools/index.js';

async function main() {
  const config = configFromEnv();
  const client = new LumiBaseClient(config);

  const server = new McpServer({
    name: 'lumibase',
    version: '0.9.0',
  });

  registerAllTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[lumibase-mcp] Fatal:', err);
  process.exit(1);
});
