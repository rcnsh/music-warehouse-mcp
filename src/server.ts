import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ClientOptions, WarehouseClient } from './client.js';
import type { Config } from './config.js';
import { today } from './format.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';

function instructions(config: Config): string {
  return [
    "Tools over one person's Spotify listening history, stored by their music-warehouse Worker since long before Spotify's own 50-play window.",
    `Dates and times are local to ${config.timeZone}; today is ${today(config.timeZone)}.`,
    'Start from search to turn an artist or song name into an id.',
    'For the top songs or artists in any date range (a month, a week, last year) use top_tracks or top_artists: get_wrapped only takes the ranges list_wrapped_ranges returns, and get_stat top-over-time is per quarter. Prefer these aggregate tools over paging get_plays.',
    'Stored-history tools work even when the Spotify grant has lapsed; now_playing, recently_played_live and spotify_top do not.',
  ].join('\n');
}

export function createServer(config: Config, options?: ClientOptions): McpServer {
  const server = new McpServer({ name: 'music-warehouse', version: VERSION }, { instructions: instructions(config) });
  registerTools(server, new WarehouseClient(config, options), config.timeZone);
  return server;
}
