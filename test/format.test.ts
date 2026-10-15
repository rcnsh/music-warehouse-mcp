import { describe, expect, it } from 'vitest';
import { clock, localTime, stripNoise, toEpochMs, today } from '../src/format.js';
import { bucketDays } from '../src/tools.js';

describe('toEpochMs', () => {
  it('reads a bare date as local midnight in the zone', () => {
    expect(toEpochMs('2024-03-01', 'UTC')).toBe(Date.UTC(2024, 2, 1));
    expect(toEpochMs('2024-03-01', 'Asia/Singapore')).toBe(Date.UTC(2024, 1, 29, 16));
    // London is on GMT in winter and BST in summer.
    expect(toEpochMs('2024-01-15', 'Europe/London')).toBe(Date.UTC(2024, 0, 15));
    expect(toEpochMs('2024-07-15', 'Europe/London')).toBe(Date.UTC(2024, 6, 14, 23));
  });

  it('takes the day DST starts, whose midnight still exists', () => {
    expect(toEpochMs('2024-03-31', 'Europe/London')).toBe(Date.UTC(2024, 2, 31));
    expect(toEpochMs('2024-10-27', 'Europe/London')).toBe(Date.UTC(2024, 9, 26, 23));
  });

  it('passes epoch-ms and ISO datetimes through', () => {
    expect(toEpochMs(1760521802000, 'UTC')).toBe(1760521802000);
    expect(toEpochMs('1760521802000', 'UTC')).toBe(1760521802000);
    expect(toEpochMs('2026-10-15T09:00:00+08:00', 'UTC')).toBe(Date.UTC(2026, 9, 15, 1));
  });

  it('rejects anything else', () => {
    expect(() => toEpochMs('last tuesday', 'UTC')).toThrow(/Not a date/);
    expect(() => toEpochMs('2024-02-30', 'UTC')).toThrow(/Not a real date/);
  });
});

describe('local formatting', () => {
  it('formats a time and today in the zone', () => {
    const ms = Date.UTC(2026, 9, 14, 20, 5);
    expect(localTime(ms, 'UTC')).toBe('2026-10-14 20:05');
    expect(localTime(ms, 'Asia/Singapore')).toBe('2026-10-15 04:05');
    expect(today('Asia/Singapore', ms)).toBe('2026-10-15');
  });

  it('formats a duration as m:ss', () => {
    expect(clock(219_000)).toBe('3:39');
    expect(clock(59_600)).toBe('1:00');
  });
});

describe('stripNoise', () => {
  it('drops art URLs and query metadata at any depth', () => {
    expect(
      stripNoise({ name: 'x', image: 'u', _meta: {}, top: [{ name: 'y', image_url: 'u', images: [], plays: 2 }] }),
    ).toEqual({ name: 'x', top: [{ name: 'y', plays: 2 }] });
  });
});

describe('bucketDays', () => {
  const days = [
    { day: '2024-01-28', plays: 1 }, // Sunday
    { day: '2024-01-29', plays: 2 }, // Monday
    { day: '2024-02-04', plays: 3 }, // Sunday
    { day: '2024-02-05', plays: 4 }, // Monday
  ];

  it('sums weeks from Monday and calendar months', () => {
    expect(bucketDays(days, 'week')).toEqual([
      { week_of: '2024-01-22', plays: 1 },
      { week_of: '2024-01-29', plays: 5 },
      { week_of: '2024-02-05', plays: 4 },
    ]);
    expect(bucketDays(days, 'month')).toEqual([
      { month: '2024-01', plays: 3 },
      { month: '2024-02', plays: 7 },
    ]);
    expect(bucketDays(days, 'day')).toBe(days);
  });
});
