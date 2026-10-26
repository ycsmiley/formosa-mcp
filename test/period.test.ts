import { expect, it } from 'vitest';
import { claimPeriod, expectedDrawDate, isClaimable, latestExpectedDrawnPeriod } from '../src/core/invoice/parse.js';
import { taipeiParts } from '../src/core/clock.js';
const clock = (iso: string) => () => new Date(iso);
it.each([
  ['2026-11-24T15:59:59Z', 115, 8], ['2026-11-24T16:00:00Z', 115, 10],
  ['2027-01-24T16:00:00Z', 115, 12], ['2027-01-24T15:59:59Z', 115, 10],
  ['2026-10-26T00:00:00Z', 115, 8],
])('latest date-rule draw at %s', (iso, rocYear, evenMonth) => expect(latestExpectedDrawnPeriod(clock(iso))).toEqual({ rocYear, evenMonth }));
it('does not use server local timezone', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    expect(taipeiParts(new Date('2026-11-24T16:00:00Z'))).toEqual({ year: 2026, month: 11, day: 25, hour: 0 });
    expect(latestExpectedDrawnPeriod(clock('2026-11-24T16:00:00Z'))).toEqual({ rocYear: 115, evenMonth: 10 });
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
it('draw dates roll into the next year', () => {
  expect(expectedDrawDate({ rocYear: 115, evenMonth: 10 })).toEqual({ year: 2026, month: 11, day: 25 });
  expect(expectedDrawDate({ rocYear: 115, evenMonth: 12 })).toEqual({ year: 2027, month: 1, day: 25 });
});
it.each([
  [8, { year: 115, month: 10, day: 6 }, { year: 116, month: 1, day: 5 }],
  [6, { year: 115, month: 8, day: 6 }, { year: 115, month: 11, day: 5 }],
])('claim dates for month %i', (evenMonth, start, end) => expect(claimPeriod({ rocYear: 115, evenMonth })).toEqual({ start, end }));
it.each([
  ['2026-11-05T15:59:59Z', true], ['2026-11-05T16:00:00Z', false],
  ['2026-08-05T15:59:59Z', false], ['2026-08-05T16:00:00Z', true],
])('claim boundary at %s', (iso, expected) => expect(isClaimable({ rocYear: 115, evenMonth: 6 }, clock(iso))).toBe(expected));
