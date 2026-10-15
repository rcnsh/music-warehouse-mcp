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
    'Start from search to turn an artist or song name into an id. Prefer the aggregate tools (top_artists, daily_play_counts, get_stat, get_wrapped, artist_history, track_history) over paging get_plays.',
    'Stored-history tools work even when the Spotify grant has lapsed; now_playing, recently_played_live and spotify_top do not.',
  ].join('\n');
}

export function createServer(config: Config, options?: ClientOptions): McpServer {
  const server = new McpServer({ name: 'music-warehouse', version: VERSION }, { instructions: instructions(config) });
  registerTools(server, new WarehouseClient(config, options), config.timeZone);
  return server;
}
