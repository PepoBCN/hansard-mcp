import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logger } from './core/logger.js';

/** Local twin of the hosted server: same registry, same core, stdout kept clean. */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('parliament-mcp-engine connected over stdio');
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'stdio startup failed');
  process.exit(1);
});
