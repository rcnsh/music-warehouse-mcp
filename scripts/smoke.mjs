// Call every tool once against a real warehouse, over stdio, as an MCP client would.
//
//   npm run build && MUSIC_WAREHOUSE_URL=https://… node scripts/smoke.mjs
//
// The token comes from MUSIC_WAREHOUSE_TOKEN, the Keychain or `npm run login`, as for the server.
// Live tools fail (and say why) if the Spotify grant has lapsed; that is not a failure here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const calls = [
  ['search', { query: 'shelter', limit: 3 }],
  ['get_plays', { limit: 3 }],
  ['top_artists', { limit: 3 }],
  ['top_tracks', { from: '2026-07-01', to: '2026-07-31', limit: 3 }],
  ['daily_play_counts', { from: '2026-01-01', group_by: 'month' }],
  ['upcoming_concerts', {}],
  ['on_this_day', {}],
  ['get_stat', { name: 'on-repeat' }],
  ['list_wrapped_ranges', {}],
  ['now_playing', {}],
  ['recently_played_live', { limit: 2 }],
  ['spotify_top', { range: 'short_term', type: 'artists', limit: 3 }],
];

const LIVE = new Set(['now_playing', 'recently_played_live', 'spotify_top']);
let failed = 0;
for (const [name, args] of calls) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0]?.text ?? '';
  if (result.isError && !LIVE.has(name)) failed++;
  console.log(`${result.isError ? 'ERR' : 'ok '} ${name} (${text.length} chars) ${text.slice(0, 160)}`);
}

// Chain search into the history tools, as an agent would.
const found = JSON.parse((await client.callTool({ name: 'search', arguments: { query: 'shelter', limit: 1 } })).content[0].text);
for (const [name, args] of [
  ['track_history', { id: found.tracks[0]?.id ?? 'none' }],
  ['artist_history', { name: found.tracks[0]?.artist ?? 'none' }],
]) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) failed++;
  console.log(`${result.isError ? 'ERR' : 'ok '} ${name} ${result.content[0].text.slice(0, 160)}`);
}

await client.close();
process.exit(failed ? 1 : 0);
