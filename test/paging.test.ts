import { describe, expect, it } from 'vitest';
import { type Before, localCursor, pageRequest, pageResult, parseBefore } from '../src/paging.js';

const row = (ms: number, id: string) => ({ played_at_ms: ms, track_id: id });

describe('parseBefore', () => {
  it('reads dates and epoch-ms as instants, its own cursors as such, and anything else as the Worker cursor', () => {
    expect(parseBefore(1000, 'UTC')).toEqual({ kind: 'instant', ms: 1000 });
    expect(parseBefore('1729000000000', 'UTC')).toEqual({ kind: 'instant', ms: 1729000000000 });
    expect(parseBefore('2024-03-01', 'UTC')).toEqual({ kind: 'instant', ms: Date.UTC(2024, 2, 1) });
    expect(parseBefore('2024-03-01T10:00:00Z', 'UTC')).toEqual({ kind: 'instant', ms: Date.UTC(2024, 2, 1, 10) });
    expect(parseBefore(localCursor(400, ['a', 'b_c-1']), 'UTC')).toEqual({ kind: 'local', ms: 400, seen: ['a', 'b_c-1'] });
    // The Worker's cursor is `<played_at_ms>.<track_id>`; a track id can itself be all digits.
    expect(parseBefore('1729000000000.6rqhFgbb', 'UTC')).toEqual({ kind: 'worker', cursor: '1729000000000.6rqhFgbb' });
    expect(parseBefore('1729000000000.1234567890123456789012', 'UTC')).toEqual({ kind: 'worker', cursor: '1729000000000.1234567890123456789012' });
    expect(() => parseBefore('mcp:x', 'UTC')).toThrow(/Not a cursor/);
    expect(() => parseBefore('2024-02-30', 'UTC')).toThrow(/Not a real date/);
  });
});

describe('pageRequest', () => {
  it('asks past the seen plays for a local cursor, within the Worker limit', () => {
    expect(pageRequest(undefined, 50)).toEqual({ limit: 50 });
    expect(pageRequest({ kind: 'worker', cursor: 'x' }, 50)).toEqual({ before: 'x', limit: 50 });
    expect(pageRequest({ kind: 'local', ms: 400, seen: ['a', 'b'] }, 50)).toEqual({ before: 401, limit: 52 });
    expect(pageRequest({ kind: 'local', ms: 400, seen: Array(400).fill('x') }, 200).limit).toBe(500);
  });
});

describe('pageResult', () => {
  it("passes the Worker's next_before through, null included", () => {
    const rows = [row(2, 'a')];
    expect(pageResult(rows, { before: undefined, limit: 1, requested: 1, nextBefore: 'c' })).toEqual({ rows, next_before: 'c' });
    expect(pageResult(rows, { before: undefined, limit: 1, requested: 1, nextBefore: null }).next_before).toBeNull();
  });

  it('without one, makes a cursor only for a full page', () => {
    expect(pageResult([row(2, 'a'), row(1, 'b')], { before: undefined, limit: 2, requested: 2, nextBefore: undefined }).next_before).toBe('mcp:1:b');
    expect(pageResult([row(2, 'a')], { before: undefined, limit: 2, requested: 2, nextBefore: undefined }).next_before).toBeNull();
  });

  it('drops plays already returned and carries the seen ones while still in the same millisecond', () => {
    const before: Before = { kind: 'local', ms: 5, seen: ['z'] };
    const rows = [row(5, 'z'), row(5, 'y'), row(5, 'x'), row(4, 'w')];
    expect(pageResult(rows, { before, limit: 2, requested: 3, nextBefore: 'ignored' })).toEqual({
      rows: [row(5, 'y'), row(5, 'x')],
      next_before: 'mcp:5:z,y,x',
    });
    expect(pageResult(rows, { before, limit: 3, requested: 4, nextBefore: undefined })).toEqual({
      rows: [row(5, 'y'), row(5, 'x'), row(4, 'w')],
      next_before: 'mcp:4:w',
    });
  });
});
