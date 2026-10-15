import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { WarehouseClient } from './client.js';
import {
  type StoredPlay,
  dateContext,
  formatPlay,
  formatSpotifyArtist,
  formatSpotifyTrack,
  localTime,
  stripNoise,
  toEpochMs,
} from './format.js';
import { pageRequest, pageResult, parseBefore } from './paging.js';

const STAT_NAMES = ['on-repeat', 'rhythm', 'top-over-time', 'eras', 'albums'] as const;

/** The most get_plays returns in one call; a full page of 500 cost about 100 KB of context. */
export const MAX_PLAYS_PER_PAGE = 200;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');
const instant = z.union([z.string(), z.number().int()]);

/** Every tool only reads. Live ones reach Spotify through the Worker. */
const STORED = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const LIVE = { readOnlyHint: true, idempotentHint: false, openWorldHint: true } as const;

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Errors become tool results the agent can read and act on, not protocol errors. */
async function attempt(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    // WarehouseError, ConfigError and bad input all carry a message meant for the agent.
    if (error instanceof Error) return { content: [{ type: 'text', text: error.message }], isError: true };
    throw error;
  }
}

/** Sum `{ day, plays }` into weeks (starting Monday) or months. */
export function bucketDays(days: Array<{ day: string; plays: number }>, by: 'day' | 'week' | 'month') {
  if (by === 'day') return days;
  const buckets = new Map<string, number>();
  for (const { day, plays } of days) {
    let key = day.slice(0, 7);
    if (by === 'week') {
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      key = date.toISOString().slice(0, 10);
    }
    buckets.set(key, (buckets.get(key) ?? 0) + plays);
  }
  return [...buckets].map(([start, plays]) => ({ [by === 'week' ? 'week_of' : 'month']: start, plays }));
}

export function registerTools(server: McpServer, client: WarehouseClient, timeZone: string) {
  const tz = { tz: timeZone };
  /** A result with today's local date first, read at call time: the server may run for days. */
  const dated = (body: unknown) =>
    body && typeof body === 'object' && !Array.isArray(body) ? { ...dateContext(timeZone), ...body } : { ...dateContext(timeZone), result: body };

  server.registerTool(
    'search',
    {
      title: 'Search artists and songs',
      description:
        'Find artists and songs in the stored listening history by name (case-insensitive substring), with all-time play counts. ' +
        'Use this first to turn a name into the id that artist_history and track_history take. An artist with id null is known ' +
        'only from the imported export: pass its name to artist_history instead.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Part of an artist or song name'),
        artist: z.string().max(200).optional().describe('Only songs whose primary artist name contains this'),
        limit: z.number().int().min(1).max(50).optional().describe('Results per list, default 10'),
      },
      annotations: STORED,
    },
    ({ query, artist, limit }) => attempt(() => client.get('search', { q: query, artist, limit })),
  );

  server.registerTool(
    'get_plays',
    {
      title: 'Individual plays',
      description:
        'Individual stored plays, newest first: local time, track, artists (with ids) and album, and which play of the song ' +
        'it was. Give `after` and `before` to read a window (newest first within it). If `next_before` is not null, pass ' +
        'it unchanged as `before` for the next, older page. For counts over a range prefer daily_play_counts, top_tracks ' +
        'or top_artists, which are far cheaper.',
      inputSchema: {
        after: instant.optional().describe('Only plays after this: YYYY-MM-DD (local midnight), an ISO datetime, or epoch-ms'),
        before: instant
          .optional()
          .describe('Only plays before this: same forms as `after`, or the `next_before` of a previous page'),
        limit: z.number().int().min(1).max(MAX_PLAYS_PER_PAGE).optional().describe('Default 50'),
        include_context: z
          .boolean()
          .optional()
          .describe('Also give the playlist, album or artist each play was played from (type, name, URI). Default false'),
      },
      annotations: STORED,
    },
    ({ after, before, limit = 50, include_context = false }) =>
      attempt(async () => {
        const cursor = before === undefined ? undefined : parseBefore(before, timeZone);
        const request = pageRequest(cursor, limit);
        const body = await client.get<{ plays: StoredPlay[]; next_before?: string | number | null }>('plays', {
          ...request,
          after: after === undefined ? undefined : toEpochMs(after, timeZone),
        });
        const page = pageResult(body.plays, {
          before: cursor,
          limit,
          requested: request.limit,
          nextBefore: 'next_before' in body ? body.next_before : undefined,
        });
        return {
          ...dateContext(timeZone),
          plays: page.rows.map((play) => formatPlay(play, timeZone, include_context)),
          next_before: page.next_before,
        };
      }),
  );

  server.registerTool(
    'top_artists',
    {
      title: 'Top artists over a date range',
      description:
        'Play counts per artist between two local dates (inclusive), most played first. Credits every artist on a track. ' +
        'Defaults to the last 30 days. Ranges up to 3,660 days.',
      inputSchema: {
        from: day.optional().describe('First day, YYYY-MM-DD; default 29 days ago'),
        to: day.optional().describe('Last day, YYYY-MM-DD; default today'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
      },
      annotations: STORED,
    },
    ({ from, to, limit }) => attempt(async () => dated(stripNoise(await client.get('top-artists', { from, to, limit, ...tz })))),
  );

  server.registerTool(
    'top_tracks',
    {
      title: 'Top songs over a date range',
      description:
        'Play counts per song between two local dates (inclusive), most played first, with editions of a song (single, ' +
        'album, remaster) folded together. Use this for "my top songs in July" or "most played song last year". ' +
        'Defaults to the last 30 days. Ranges up to 3,660 days.',
      inputSchema: {
        from: day.optional().describe('First day, YYYY-MM-DD; default 29 days ago'),
        to: day.optional().describe('Last day, YYYY-MM-DD; default today'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 20'),
      },
      annotations: STORED,
    },
    ({ from, to, limit = 20 }) => attempt(async () => dated(stripNoise(await client.get('top-tracks', { from, to, limit, ...tz })))),
  );

  server.registerTool(
    'daily_play_counts',
    {
      title: 'Plays per day, week or month',
      description:
        'How many plays on each local day between two dates, quiet days as 0, optionally summed into weeks (from Monday) or ' +
        'months. Use month or week for spans longer than a few months.',
      inputSchema: {
        from: day.optional().describe('First day, YYYY-MM-DD; default 29 days ago'),
        to: day.optional().describe('Last day, YYYY-MM-DD; default today'),
        group_by: z.enum(['day', 'week', 'month']).optional().describe('Default day'),
      },
      annotations: STORED,
    },
    ({ from, to, group_by = 'day' }) =>
      attempt(async () => {
        const body = await client.get<{ from: string; to: string; days: Array<{ day: string; plays: number }> }>('daily', {
          from,
          to,
          ...tz,
        });
        const total = body.days.reduce((sum, d) => sum + d.plays, 0);
        return { ...dateContext(timeZone), from: body.from, to: body.to, total, [`${group_by}s`]: bucketDays(body.days, group_by) };
      }),
  );

  server.registerTool(
    'artist_history',
    {
      title: "One artist's whole history",
      description:
        "An artist's all-time plays, estimated minutes, first and last play, plays per month, and their most-played songs. " +
        'Counts only plays where they are the primary artist. Give the id from search, or the name (which also catches plays ' +
        'from the imported export), or both.',
      inputSchema: {
        id: z.string().optional().describe('Spotify artist id'),
        name: z.string().optional().describe('Artist name, matched case-insensitively'),
      },
      annotations: STORED,
    },
    ({ id, name }) =>
      attempt(async () => {
        if (!id && !name) throw new Error('Give an id or a name.');
        return dated(stripNoise(await client.get('artist', { id, name, ...tz })));
      }),
  );

  server.registerTool(
    'track_history',
    {
      title: "One song's whole history",
      description:
        "A song's all-time plays, estimated minutes, first and last play, and plays per month, with every edition of it " +
        '(single, album, remaster) folded together. Takes a track id: use search to find one by name.',
      inputSchema: { id: z.string().min(1).describe('Spotify track id') },
      annotations: STORED,
    },
    ({ id }) => attempt(async () => dated(stripNoise(await client.get('track', { id, ...tz })))),
  );

  server.registerTool(
    'upcoming_concerts',
    {
      title: 'Upcoming concerts',
      description:
        'Upcoming Ticketmaster music events in the regions the warehouse is configured to watch, for the ~80 artists ' +
        'played most over the last year; soonest first, refreshed daily. The response lists those regions (key and ' +
        "label). `since` keeps only events first seen on or after that date, to answer what's new. An artist absent " +
        'here may simply not be on Ticketmaster under the same name.',
      inputSchema: {
        region: z
          .string()
          .regex(/^[a-z0-9-]{1,32}$/)
          .optional()
          .describe('One region key from a previous response; default all'),
        since: day.optional().describe('Only events first seen on or after this local date'),
      },
      annotations: STORED,
    },
    ({ region, since }) => attempt(async () => dated(await client.get('concerts', { region, since, ...tz }))),
  );

  server.registerTool(
    'on_this_day',
    {
      title: 'On this day in earlier years',
      description: 'The most-played songs on this calendar date in each earlier year, with that day’s total plays.',
      inputSchema: { date: day.optional().describe('YYYY-MM-DD; default today') },
      annotations: STORED,
    },
    ({ date }) => attempt(async () => dated(stripNoise(await client.get('on-this-day', { date, ...tz })))),
  );

  server.registerTool(
    'get_stat',
    {
      title: 'Precomputed listening stats',
      description:
        'All-time aggregates, refreshed every few hours. on-repeat: songs and albums played far more than usual in the last ' +
        '14 days. rhythm: listening streaks and plays by hour. top-over-time: top artists and songs per quarter and per year. ' +
        'eras: how taste changed in the latest era the warehouse is configured with (e.g. after a move) against the months before it. albums: most-played albums, all time and per year.',
      inputSchema: { name: z.enum(STAT_NAMES) },
      annotations: STORED,
    },
    ({ name }) => attempt(async () => stripNoise(await client.get(`stats/${name}`))),
  );

  server.registerTool(
    'list_wrapped_ranges',
    {
      title: 'Wrapped ranges available',
      description: 'The date ranges get_wrapped can summarise: each year with plays, and this year so far.',
      annotations: STORED,
    },
    () => attempt(async () => dated(await client.get('wrapped/ranges'))),
  );

  server.registerTool(
    'get_wrapped',
    {
      title: 'Wrapped-style summary',
      description:
        'A Spotify-Wrapped-style summary of a finished date range: minutes, top artists, songs and albums, biggest day, streak, ' +
        'listening by hour and weekday, each month’s top artist and song, discoveries and a listening age. Use a range from ' +
        'list_wrapped_ranges; others may be refused.',
      inputSchema: { from: day, to: day },
      annotations: STORED,
    },
    ({ from, to }) => attempt(async () => stripNoise(await client.get('wrapped', { from, to }))),
  );

  server.registerTool(
    'now_playing',
    {
      title: 'Playing right now',
      description: "What Spotify is playing right now, live, or null when nothing is. Needs the warehouse's Spotify grant.",
      annotations: LIVE,
    },
    () =>
      attempt(async () => {
        const { item } = await client.get<{ item: NowPlaying | null }>('now-playing');
        if (!item?.item) return { playing: null };
        return {
          playing: {
            ...formatSpotifyTrack(item.item),
            is_playing: item.is_playing ?? null,
            progress: item.progress_ms == null ? null : `${Math.round(item.progress_ms / 1000)} s`,
            context: item.context?.uri ?? null,
          },
        };
      }),
  );

  server.registerTool(
    'recently_played_live',
    {
      title: 'Recently played, live from Spotify',
      description:
        "Spotify's own last plays (at most 50), including ones the warehouse has not stored yet (it polls every 30 minutes). " +
        'For anything older use get_plays. Needs the Spotify grant.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Default 10') },
      annotations: LIVE,
    },
    ({ limit = 10 }) =>
      attempt(async () => {
        const body = await client.get<{ items: Array<{ track: SpotifyTrackLike; played_at: string; context?: { uri?: string } | null }> }>(
          'recently-played',
          { limit },
        );
        return {
          ...dateContext(timeZone),
          plays: body.items.map((item) => ({
            played_at: localTime(Date.parse(item.played_at), timeZone),
            ...formatSpotifyTrack(item.track),
            context: item.context?.uri ?? null,
          })),
        };
      }),
  );

  server.registerTool(
    'spotify_top',
    {
      title: "Spotify's top lists",
      description:
        "Spotify's own top tracks and artists, live. short_term is about 4 weeks, medium_term about 6 months, " +
        'long_term about a year. For exact counts over any range, use top_artists or get_stat instead. Needs the Spotify grant.',
      inputSchema: {
        range: z.enum(['short_term', 'medium_term', 'long_term']).optional().describe('Default long_term'),
        type: z.enum(['tracks', 'artists']).optional().describe('Only one list; default both'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 12'),
      },
      annotations: LIVE,
    },
    ({ range, type, limit }) =>
      attempt(async () => {
        const body = await client.get<{
          range: string;
          tracks: { items: SpotifyTrackLike[] } | null;
          artists: { items: Array<Parameters<typeof formatSpotifyArtist>[0]> } | null;
        }>('top', { range, type, limit });
        return {
          range: body.range,
          tracks: body.tracks?.items.map(formatSpotifyTrack) ?? null,
          artists: body.artists?.items.map(formatSpotifyArtist) ?? null,
        };
      }),
  );
}

type SpotifyTrackLike = NonNullable<Parameters<typeof formatSpotifyTrack>[0]>;

interface NowPlaying {
  is_playing?: boolean;
  progress_ms?: number | null;
  item?: SpotifyTrackLike | null;
  context?: { uri?: string } | null;
}
