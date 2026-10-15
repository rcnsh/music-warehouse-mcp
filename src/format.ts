/**
 * Shaping responses for an agent: drop what costs tokens and tells it nothing
 * (art URLs, API links, market lists), and give times in the user's zone.
 */

const DROPPED_KEYS = new Set(['image', 'image_url', 'images', '_meta']);

/** The warehouse's own responses, minus art URLs and query metadata. */
export function stripNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNoise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !DROPPED_KEYS.has(key))
        .map(([key, child]) => [key, stripNoise(child)]),
    );
  }
  return value;
}

/** `2026-10-15 14:55` in the given zone. */
export function localTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}

/** Today's `YYYY-MM-DD` in the given zone. */
export function today(timeZone: string, now = Date.now()): string {
  return localTime(now, timeZone).slice(0, 10);
}

/**
 * An instant from an ISO date, ISO datetime or epoch-ms. A bare date is the
 * start of that day in `timeZone`, so `after: 2024-03-01` means from that
 * morning where the user is.
 */
export function toEpochMs(input: string | number, timeZone: string): number {
  if (typeof input === 'number' || /^\d{10,}$/.test(input)) return Number(input);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return startOfLocalDay(input, timeZone);
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) throw new Error(`Not a date, datetime or epoch-ms: ${input}`);
  return ms;
}

/** UTC ms of local midnight on `day` in `timeZone`, by correcting a UTC guess with the zone's offset. */
function startOfLocalDay(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  // Date.parse rolls 30 February over into March rather than failing.
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 10) !== day) throw new Error(`Not a real date: ${day}`);
  let ms = guess;
  // Twice, so a guess that lands across a DST change settles.
  for (let i = 0; i < 2; i++) ms = guess - offsetMs(ms, timeZone);
  return ms;
}

function offsetMs(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(ms)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The current local date and the zone, for tool results where dates matter. */
export function dateContext(timeZone: string, now = Date.now()) {
  return { today: today(timeZone, now), tz: timeZone };
}

/** One row of /api/plays. The optional fields are absent from Workers that predate them. */
export interface StoredPlay {
  played_at_ms: number;
  track_id: string;
  track_name: string | null;
  /** The credited artists joined with commas. */
  artists: string | null;
  /** The credited artists in order, with ids for artist_history. */
  artist_list?: Array<{ id: string; name: string }>;
  album_name: string | null;
  duration_ms: number | null;
  context_type: string | null;
  context_uri: string | null;
  context_name?: string | null;
  /** Which play of its song this was; null when not numbered yet. */
  play_number?: number | null;
  source: string;
}

/**
 * A play as the agent sees it. Each value stays in its own field, as the
 * Worker gave it: names are the user's data and never become prose. The
 * context (playlist, album or artist it was played from) only on request.
 */
export function formatPlay(play: StoredPlay, timeZone: string, includeContext = false) {
  return {
    played_at: localTime(play.played_at_ms, timeZone),
    track: play.track_name,
    track_id: play.track_id,
    artists: play.artist_list?.length ? play.artist_list : play.artists,
    album: play.album_name,
    ...(play.play_number !== undefined ? { play_number: play.play_number } : {}),
    ...(includeContext
      ? {
          context: play.context_type
            ? { type: play.context_type, name: play.context_name ?? null, uri: play.context_uri }
            : null,
        }
      : {}),
  };
}

// Spotify's own objects, from the live routes.

interface SpotifyArtist {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
}

interface SpotifyTrack {
  id: string | null;
  name: string;
  artists?: SpotifyArtist[];
  album?: { name: string; release_date?: string };
  duration_ms?: number;
}

export function formatSpotifyTrack(track: SpotifyTrack | null | undefined) {
  if (!track) return null;
  return {
    id: track.id,
    name: track.name,
    artists: track.artists?.map((artist) => artist.name).join(', ') ?? null,
    album: track.album?.name ?? null,
    released: track.album?.release_date ?? null,
    duration: track.duration_ms === undefined ? null : clock(track.duration_ms),
  };
}

/** Genres and popularity only when Spotify sends them; it leaves them empty for some apps. */
export function formatSpotifyArtist(artist: SpotifyArtist) {
  return {
    id: artist.id,
    name: artist.name,
    ...(artist.genres?.length ? { genres: artist.genres } : {}),
    ...(artist.popularity != null ? { popularity: artist.popularity } : {}),
  };
}

/** `3:05`. */
export function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
