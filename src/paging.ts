import { toEpochMs } from './format.js';

/**
 * Paging /api/plays without losing plays that share a millisecond.
 *
 * Plays are keyed by (played_at_ms, track_id), and imported history has many
 * plays in the same millisecond. A Worker that returns `next_before` hands
 * out a cursor over that whole key, and it is passed back untouched. An older
 * Worker only takes `before` as an epoch-ms and returns plays strictly before
 * it, so paging by the last row's millisecond skips the rest of that
 * millisecond. For those, the cursor is made here: the last millisecond and
 * the track ids already returned in it. The next page asks for plays before
 * the millisecond after it and drops the ones already seen.
 */

const LOCAL_PREFIX = 'mcp:';

/** The Worker's own `limit` ceiling. */
const WORKER_MAX_LIMIT = 500;

export type Before =
  | { kind: 'instant'; ms: number }
  /** A cursor the Worker issued, passed back as it came. */
  | { kind: 'worker'; cursor: string }
  /** A cursor made here for a Worker without `next_before`. */
  | { kind: 'local'; ms: number; seen: string[] };

export function localCursor(ms: number, seen: string[]): string {
  return `${LOCAL_PREFIX}${ms}:${seen.join(',')}`;
}

/**
 * What `before` means: a cursor from a previous page, or a date, datetime or
 * epoch-ms. Anything that isn't one of those is taken as the Worker's cursor
 * (it is opaque), and the Worker says if it isn't.
 */
export function parseBefore(input: string | number, timeZone: string): Before {
  if (typeof input === 'string' && input.startsWith(LOCAL_PREFIX)) {
    const match = /^mcp:(\d+):([A-Za-z0-9_,-]*)$/.exec(input);
    if (!match) throw new Error(`Not a cursor this server issued: ${input}`);
    return { kind: 'local', ms: Number(match[1]), seen: match[2] ? match[2].split(',') : [] };
  }
  // Only what looks like a date or epoch-ms is read as one: Date.parse takes
  // odd strings, and a cursor must never be mistaken for a time.
  if (typeof input === 'number' || /^(\d{10,}|\d{4}-\d{2}-\d{2}([T ].*)?)$/.test(input)) {
    return { kind: 'instant', ms: toEpochMs(input, timeZone) };
  }
  return { kind: 'worker', cursor: input };
}

/** The `before` and `limit` to send for a page of `limit` plays. */
export function pageRequest(before: Before | undefined, limit: number): { before?: string | number; limit: number } {
  if (!before) return { limit };
  if (before.kind === 'instant') return { before: before.ms, limit };
  if (before.kind === 'worker') return { before: before.cursor, limit };
  // The seen plays come back again, so ask for that many more.
  return { before: before.ms + 1, limit: Math.min(limit + before.seen.length, WORKER_MAX_LIMIT) };
}

interface Keyed {
  played_at_ms: number;
  track_id: string;
}

/**
 * The page to show and the cursor for the next one. `requested` is the limit
 * sent; `nextBefore` is the Worker's field, undefined when it sent none.
 */
export function pageResult<T extends Keyed>(
  rows: T[],
  options: { before: Before | undefined; limit: number; requested: number; nextBefore: string | number | null | undefined },
): { rows: T[]; next_before: string | number | null } {
  const { before, limit, requested, nextBefore } = options;
  // The Worker's cursor matches its last row, so it holds only when the page is that page.
  if (before?.kind !== 'local' && nextBefore !== undefined) return { rows, next_before: nextBefore };

  const seen = before?.kind === 'local' ? new Set(before.seen) : new Set<string>();
  const fresh = before?.kind === 'local' ? rows.filter((row) => !(row.played_at_ms === before.ms && seen.has(row.track_id))) : rows;
  const page = fresh.slice(0, limit);
  const more = rows.length >= requested || fresh.length > limit;
  const last = page.at(-1);
  if (!more || !last) return { rows: page, next_before: null };

  const inLast = page.filter((row) => row.played_at_ms === last.played_at_ms).map((row) => row.track_id);
  const carried = before?.kind === 'local' && before.ms === last.played_at_ms ? before.seen : [];
  return { rows: page, next_before: localCursor(last.played_at_ms, [...new Set([...carried, ...inLast])]) };
}
