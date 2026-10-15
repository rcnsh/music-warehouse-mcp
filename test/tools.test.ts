import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';

type Route = (url: URL) => unknown;

/** A server over a fake warehouse, and an MCP client connected to it. */
async function connect(routes: Record<string, Route>) {
  const requests: URL[] = [];
  const fetch = vi.fn(async (input: URL | string | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify(route(url)), { status: 200 });
  });
  const config = { url: 'https://warehouse.test', timeZone: 'Asia/Singapore', token: async () => 't' };
  const server = createServer(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => {} });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = result.content[0]!.text;
    return { isError: result.isError ?? false, text, json: () => JSON.parse(text) };
  }
  return { client, call, requests };
}

describe('tools', () => {
  it('lists every tool, all read-only', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'artist_history',
      'daily_play_counts',
      'get_plays',
      'get_stat',
      'get_wrapped',
      'list_wrapped_ranges',
      'now_playing',
      'on_this_day',
      'recently_played_live',
      'search',
      'spotify_top',
      'top_artists',
      'track_history',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('gives the agent instructions with the zone', async () => {
    const { client } = await connect({});
    expect(client.getInstructions()).toMatch(/local to Asia\/Singapore/);
  });

  it('get_plays converts dates to epoch-ms in the zone and pages with next_before', async () => {
    const play = (ms: number) => ({
      played_at_ms: ms,
      track_id: `t${ms}`,
      track_name: 'Shelter',
      artists: 'Porter Robinson, Madeon',
      album_name: 'Shelter',
      image_url: 'https://i.scdn.co/x',
      duration_ms: 219000,
      isrc: 'X',
      context_uri: 'spotify:playlist:1',
      context_type: 'playlist',
      source: 'api',
    });
    const { call, requests } = await connect({
      '/api/plays': () => ({ plays: [play(Date.UTC(2024, 2, 1, 2)), play(Date.UTC(2024, 2, 1, 1))], _meta: {} }),
    });
    const body = (await call('get_plays', { after: '2024-03-01', limit: 2 })).json();
    expect(requests[0]!.searchParams.get('after')).toBe(String(Date.UTC(2024, 1, 29, 16)));
    expect(body.plays[0]).toEqual({
      played_at: '2024-03-01 10:00',
      played_at_ms: Date.UTC(2024, 2, 1, 2),
      track: 'Shelter',
      artists: 'Porter Robinson, Madeon',
      album: 'Shelter',
      track_id: `t${Date.UTC(2024, 2, 1, 2)}`,
      context: 'playlist spotify:playlist:1',
    });
    expect(body.next_before).toBe(Date.UTC(2024, 2, 1, 1));
    expect((await call('get_plays', { limit: 3 })).json().next_before).toBeNull();
  });

  it('passes the zone to the history routes and strips art', async () => {
    const { call, requests } = await connect({
      '/api/artist': (url) => ({ artist: { id: null, name: url.searchParams.get('name') }, plays: 3, top_tracks: [{ name: 'a', image: 'u' }] }),
    });
    expect((await call('artist_history', { name: 'Madeon' })).json()).toEqual({
      artist: { id: null, name: 'Madeon' },
      plays: 3,
      top_tracks: [{ name: 'a' }],
    });
    expect(requests[0]!.searchParams.get('tz')).toBe('Asia/Singapore');
    expect(await call('artist_history', {})).toMatchObject({ isError: true, text: 'Give an id or a name.' });
  });

  it('daily_play_counts can sum into months with a total', async () => {
    const { call } = await connect({
      '/api/daily': () => ({
        from: '2024-01-30',
        to: '2024-02-01',
        days: [
          { day: '2024-01-30', plays: 1 },
          { day: '2024-01-31', plays: 2 },
          { day: '2024-02-01', plays: 4 },
        ],
      }),
    });
    expect((await call('daily_play_counts', { group_by: 'month' })).json()).toEqual({
      from: '2024-01-30',
      to: '2024-02-01',
      tz: 'Asia/Singapore',
      total: 7,
      months: [
        { month: '2024-01', plays: 3 },
        { month: '2024-02', plays: 4 },
      ],
    });
  });

  it('rejects input the schema forbids before calling the warehouse', async () => {
    const { client, requests } = await connect({});
    const result = (await client.callTool({ name: 'get_stat', arguments: { name: 'everything' } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('reduces Spotify objects to what an agent needs', async () => {
    const track = {
      id: 'tid',
      name: 'Count Me Out',
      artists: [{ id: 'a', name: 'Kendrick Lamar', href: 'x' }],
      album: { name: 'Mr. Morale', release_date: '2022-05-13', images: [{ url: 'u' }] },
      duration_ms: 283_000,
      available_markets: ['GB'],
    };
    const { call } = await connect({
      '/api/now-playing': () => ({ item: { is_playing: true, progress_ms: 61_400, item: track, context: { uri: 'spotify:album:1' } } }),
      '/api/top': () => ({ range: 'short_term', tracks: null, artists: { items: [{ id: 'a', name: 'Kendrick Lamar', genres: ['rap'], popularity: 90, images: [] }, { id: 'b', name: 'SZA', genres: [], popularity: null }] } }),
      '/api/recently-played': () => ({ items: [{ track, played_at: '2026-10-15T06:55:59.616Z', context: null }] }),
    });
    expect((await call('now_playing')).json()).toEqual({
      playing: {
        id: 'tid',
        name: 'Count Me Out',
        artists: 'Kendrick Lamar',
        album: 'Mr. Morale',
        released: '2022-05-13',
        duration: '4:43',
        is_playing: true,
        progress: '61 s',
        context: 'spotify:album:1',
      },
    });
    expect((await call('spotify_top', { range: 'short_term', type: 'artists' })).json()).toEqual({
      range: 'short_term',
      tracks: null,
      artists: [{ id: 'a', name: 'Kendrick Lamar', genres: ['rap'], popularity: 90 }, { id: 'b', name: 'SZA' }],
    });
    expect((await call('recently_played_live')).json().plays[0]).toMatchObject({ played_at: '2026-10-15 14:55', name: 'Count Me Out' });
  });

  it('says when nothing is playing', async () => {
    const { call } = await connect({ '/api/now-playing': () => ({ item: null }) });
    expect((await call('now_playing')).json()).toEqual({ playing: null });
  });

  it('turns a warehouse error into a readable tool error', async () => {
    const { call } = await connect({});
    expect(await call('get_stat', { name: 'rhythm' })).toMatchObject({ isError: true, text: 'Warehouse error 404: Not found' });
  });
});
