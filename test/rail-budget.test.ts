import { expect, it } from 'vitest';
import { allowance, calendar, decide, quota, snapshotReserve, type Counts } from '../src/core/rail/budget.js';
import { defaultTdxBase, tdxBase } from '../src/core/rail/client.js';
const now = new Date('2026-10-01T00:00:00Z');
const counts: Counts = { monthUsed: 0, todayUsed: 0, last60s: 0, hasKey: true };
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
  expect(allowance(usage, new Date('2026-10-21T00:00:00Z'))).toEqual({ monthlyQuota: 4500, snapshotReserve: 200, snapshotReported: 0, liveCeiling: 3850, dailyBudget: Math.floor((3850 - 2000) / 11) });
  expect(decide(86, { ...counts, monthUsed: 100, todayUsed: 100, last60s: 0 }, now)).toEqual({ ok: false, reason: 'daily' });
});
it.each([
  [{ hasKey: false }, 'nokey'], [{ last60s: 3 }, 'minute'],
  [{ todayUsed: 124, monthUsed: 124 }, 'daily'], [{ monthUsed: 3849 }, 'monthly'], [{ ipMisses: 6 }, 'ip'],
] as const)('rejects a two-call live admission for %j with %s', (change, reason) => {
  expect(decide(2, { ...counts, ...change }, now)).toEqual({ ok: false, reason });
});
it('accepts each boundary inclusively and checks token plus data together', () => {
  expect(decide(2, { ...counts, last60s: 2, ipMisses: 5 }, now)).toEqual({ ok: true });
  expect(decide(1, { ...counts, monthUsed: 3849, todayUsed: 0 }, new Date('2026-10-31T00:00:00Z'))).toEqual({ ok: true });
  expect(decide(1, { ...counts, monthUsed: 123, todayUsed: 123 }, now)).toEqual({ ok: true });
});
it('charges the larger of the reserve and reported collector use', () => {
  expect(allowance(counts, now).liveCeiling).toBe(3850);
  expect(allowance({ ...counts, collectorUsed: 199 }, now).liveCeiling).toBe(3850);
  expect(allowance({ ...counts, collectorUsed: 250 }, now).liveCeiling).toBe(3800);
  expect(allowance({ ...counts, collectorUsed: 5000 }, now).liveCeiling).toBe(0);
});
it('clamps the snapshot reserve to integer quota bounds', () => {
  expect(snapshotReserve()).toBe(200);
  expect(snapshotReserve('')).toBe(200);
  expect(snapshotReserve('invalid')).toBe(200);
  expect(snapshotReserve('-2')).toBe(0);
  expect(snapshotReserve('2.9')).toBe(2);
  expect(snapshotReserve('9999')).toBe(4500);
  expect(snapshotReserve('200', 20)).toBe(20);
});
it('handles a tiny quota and exhausts the remaining daily allowance', () => {
  const small = { ...counts, monthlyQuota: 20, snapshotReserve: 2 };
  expect(allowance(small, now).liveCeiling).toBe(16);
  expect(allowance(small, now).dailyBudget).toBe(0);
  const last = new Date('2026-10-31T00:00:00Z');
  expect(allowance({ ...small, monthUsed: 14, todayUsed: 2 }, last).dailyBudget).toBe(4);
  expect(decide(2, { ...small, monthUsed: 14, todayUsed: 2 }, last)).toEqual({ ok: true });
  expect(decide(3, { ...small, monthUsed: 14, todayUsed: 2 }, last)).toEqual({ ok: false, reason: 'monthly' });
});
it.each(['0', '-1', '4501', '4.5', 'NaN', '', '1e2'])('ignores invalid quota %s', value => expect(quota(value)).toBe(4500));
it('only accepts lower integer quota and HTTP loopback origins', () => {
  expect(quota('100')).toBe(100); expect(quota('4500')).toBe(4500);
  expect(tdxBase('http://127.0.0.1:8888/path')).toBe('http://127.0.0.1:8888');
  expect(tdxBase('http://localhost:8888')).toBe('http://localhost:8888');
  for (const url of ['http://example.test', 'https://localhost', 'http://localhost.example.test', 'http://user:pass@localhost']) expect(tdxBase(url)).toBe(defaultTdxBase);
});
