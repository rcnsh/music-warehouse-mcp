#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';

try {
  const config = loadConfig();
  await createServer(config).connect(new StdioServerTransport());
  // stdout is the protocol; anything for a human goes to stderr.
  console.error(`music-warehouse MCP server reading ${config.url} (${config.timeZone})`);
} catch (error) {
  console.error(error instanceof ConfigError ? `music-warehouse-mcp: ${error.message}` : error);
  process.exit(1);
}
