#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runCli } from './cli.js';
import { ConfigError, loadConfig } from './config.js';
import { staleBuildNotice, staleSources } from './freshness.js';
import { createServer } from './server.js';

const [command, ...args] = process.argv.slice(2);

if (command !== undefined) {
  // A command (`login`, `--help`) is for a person at a terminal; stdout is theirs.
  process.exit(await runCli(command, args));
}

try {
  const config = loadConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const stale = staleSources(here, join(here, '..', 'src'));
  const notices = stale.length ? [staleBuildNotice(stale)] : [];
  for (const notice of notices) console.error(`music-warehouse-mcp: ${notice}`);
  await createServer(config, { notices }).connect(new StdioServerTransport());
  // stdout is the protocol; anything for a human goes to stderr.
  console.error(`music-warehouse MCP server reading ${config.url} (${config.timeZone})`);
} catch (error) {
  console.error(error instanceof ConfigError ? `music-warehouse-mcp: ${error.message}` : error);
  process.exit(1);
}
