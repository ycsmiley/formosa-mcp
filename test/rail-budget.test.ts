import { expect, it } from 'vitest';
import { allowance, calendar, decide, quota, type Counts } from '../src/core/rail/budget.js';
import { defaultTdxBase, tdxBase } from '../src/core/rail/client.js';
const now = new Date('2026-10-01T00:00:00Z');
const counts: Counts = { monthUsed: 0, todayUsed: 0, snapshotToday: 0, last60s: 0, hasKey: true };
it.each([
  ['2026-10-31T15:59:59Z', '2026-10-31', '2026-10', 31, 1],
  ['2026-10-31T16:00:00Z', '2026-11-01', '2026-11', 30, 30],
  ['2026-02-28T15:59:59Z', '2026-02-28', '2026-02', 28, 1],
  ['2028-02-28T16:00:00Z', '2028-02-29', '2028-02', 29, 1],
  ['2028-02-29T16:00:00Z', '2028-03-01', '2028-03', 31, 31],
  ['2026-12-31T16:00:00Z', '2027-01-01', '2027-01', 31, 31],
])('uses Taipei calendar at %s', (instant, today, month, daysInMonth, remainingDays) => {
  expect(calendar(new Date(instant))).toEqual({ today, month, daysInMonth, remainingDays });
});
it('allocates remaining live ceiling over remaining days, excluding today from prior use', () => {
  const usage = { ...counts, monthUsed: 2100, todayUsed: 100 };
  expect(allowance(usage, new Date('2026-10-21T00:00:00Z'))).toEqual({ monthlyQuota: 4500, liveCeiling: 4050, dailyBudget: Math.floor((4050 - 2000) / 11) });
  expect(decide(86, 'live', { ...counts, monthUsed: 100, todayUsed: 100, last60s: 0 }, now)).toEqual({ ok: false, reason: 'daily' });
});
it.each([
  [{ hasKey: false }, 'nokey'], [{ last60s: 3 }, 'minute'],
  [{ todayUsed: 130, monthUsed: 130 }, 'daily'], [{ monthUsed: 4049 }, 'monthly'], [{ ipMisses: 6 }, 'ip'],
] as const)('rejects a two-call live admission for %j with %s', (change, reason) => {
  expect(decide(2, 'live', { ...counts, ...change }, now)).toEqual({ ok: false, reason });
});
it('accepts each boundary inclusively and checks token plus data together', () => {
  expect(decide(2, 'live', { ...counts, last60s: 2, ipMisses: 5 }, now)).toEqual({ ok: true });
  expect(decide(1, 'live', { ...counts, monthUsed: 4049, todayUsed: 0 }, new Date('2026-10-31T00:00:00Z'))).toEqual({ ok: true });
  expect(decide(1, 'live', { ...counts, monthUsed: 129, todayUsed: 129 }, now)).toEqual({ ok: true });
});
it('reserves the final ten percent for snapshots, with minute and daily bug guards', () => {
  const high = { ...counts, monthUsed: 4400, todayUsed: 150, snapshotToday: 18 };
  expect(decide(2, 'snapshot', high, now)).toEqual({ ok: true });
  expect(decide(3, 'snapshot', high, now)).toEqual({ ok: false, reason: 'daily' });
  expect(decide(1, 'snapshot', { ...high, monthUsed: 4500 }, now)).toEqual({ ok: false, reason: 'monthly' });
  expect(decide(1, 'snapshot', { ...high, last60s: 4 }, now)).toEqual({ ok: false, reason: 'minute' });
});
it.each(['0', '-1', '4501', '4.5', 'NaN', '', '1e2'])('ignores invalid quota %s', value => expect(quota(value)).toBe(4500));
it('only accepts lower integer quota and HTTP loopback origins', () => {
  expect(quota('100')).toBe(100); expect(quota('4500')).toBe(4500);
  expect(tdxBase('http://127.0.0.1:8888/path')).toBe('http://127.0.0.1:8888');
  expect(tdxBase('http://localhost:8888')).toBe('http://localhost:8888');
  for (const url of ['http://example.test', 'https://localhost', 'http://localhost.example.test', 'http://user:pass@localhost']) expect(tdxBase(url)).toBe(defaultTdxBase);
});
