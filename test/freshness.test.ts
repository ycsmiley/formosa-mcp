import { describe, expect, it } from 'vitest';
import { INVOICE_DRAW_BUFFER_MS, RAIL_STATIONS_STALE_MS, RAIL_TIMETABLE_STALE_MS, TPEX_DIVIDENDS_STALE_MS, TWSE_WEEKDAY_STALE_MS, TWSE_WEEKEND_STALE_MS, invoiceWarning, isStale, railWarnings, staleWarning, twseDividendsThreshold } from '../src/core/freshness.js';
import { expectedDrawDate, type Draw, type Period } from '../src/core/invoice/parse.js';
import { readSuccessAt } from '../src/worker/freshness.js';
const at = '2026-11-02T01:00:00Z';
const draw = (period: Period): Draw => ({ period, special: '12345678', grand: '23456789', first: [], extraSixth: [] });

describe('snapshot freshness boundaries', () => {
  it.each([
    ['TWSE weekday', TWSE_WEEKDAY_STALE_MS], ['TWSE weekend', TWSE_WEEKEND_STALE_MS],
    ['TPEx dividends', TPEX_DIVIDENDS_STALE_MS], ['rail timetable', RAIL_TIMETABLE_STALE_MS], ['rail stations', RAIL_STATIONS_STALE_MS],
  ])('%s: only warns strictly after the threshold', (_, threshold) => {
    for (const offset of [-1, 0, 1]) expect(isStale(at, new Date(Date.parse(at) + threshold + offset), threshold)).toBe(offset > 0);
  });
  it('uses the UTC cron calendar, including Sunday → Monday and Friday → Saturday', () => {
    expect(twseDividendsThreshold(at, new Date(at))).toBe(TWSE_WEEKDAY_STALE_MS);
    expect(twseDividendsThreshold('2026-11-01T18:00:00Z', new Date('2026-11-02T00:05:00Z'))).toBe(TWSE_WEEKEND_STALE_MS);
    expect(twseDividendsThreshold('2026-11-06T23:30:00Z', new Date('2026-11-07T00:05:00Z'))).toBe(TWSE_WEEKEND_STALE_MS);
    // Taipei Saturday morning is still a UTC Friday weekday cron.
    expect(twseDividendsThreshold('2026-11-06T20:00:00Z', new Date('2026-11-06T20:30:00Z'))).toBe(TWSE_WEEKDAY_STALE_MS);
  });
  it('tolerates the actual TPEx weekend gap and immutable tomorrow timetable reuse', () => {
    expect(isStale('2026-11-06T10:47:00Z', new Date('2026-11-09T06:17:00Z'), TPEX_DIVIDENDS_STALE_MS)).toBe(false);
    expect(isStale('2026-11-01T00:23:00+08:00', new Date('2026-11-02T23:59:00+08:00'), RAIL_TIMETABLE_STALE_MS)).toBe(false);
    expect(isStale(at, new Date('2026-11-10T01:00:00Z'), RAIL_STATIONS_STALE_MS)).toBe(false);
  });
  it('formats a shared warning in Taipei time and handles unknown times', () => {
    expect(staleWarning(at)).toBe('⚠️ 資料可能不是最新（最後更新：2026-11-02 09:00（臺北時間））');
    expect(isStale('invalid', new Date(at), 1000)).toBe(true);
    expect(isStale(undefined, new Date(at), 1000)).toBe(true);
    expect(staleWarning(undefined)).toContain('更新時間未提供');
  });
  it('checks timetable and station fetch clocks independently', () => {
    const now = new Date(at), old = { fetchedAt: '2000-01-01T00:00:00Z' }, fresh = { fetchedAt: at };
    expect(railWarnings([fresh], fresh, now)).toEqual([]);
    expect(railWarnings([old], fresh, now)).toEqual([staleWarning(old.fetchedAt, '表訂時刻表')]);
    expect(railWarnings([fresh], old, now)).toEqual([staleWarning(old.fetchedAt, '車站資料')]);
  });
});

describe('invoice draw calendar freshness', () => {
  // Every odd month, including January's previous-year November/December draw.
  it.each([1, 3, 5, 7, 9, 11])('month %i: before/during draw, grace period, overdue and newly available period', month => {
    const expected = month === 1 ? { rocYear: 114, evenMonth: 12 } : { rocYear: 115, evenMonth: month - 1 };
    const previous = expected.evenMonth === 2 ? { rocYear: expected.rocYear - 1, evenMonth: 12 } : { ...expected, evenMonth: expected.evenMonth - 2 };
    const d = expectedDrawDate(expected);
    const announcement = Date.parse(`${d.year}-${String(d.month).padStart(2, '0')}-25T00:00:00+08:00`);
    for (const offset of [-1, 0, INVOICE_DRAW_BUFFER_MS - 86400_000, INVOICE_DRAW_BUFFER_MS - 1, INVOICE_DRAW_BUFFER_MS]) {
      expect(invoiceWarning([draw(previous)], at, new Date(announcement + offset))).toBe('');
    }
    for (const offset of [INVOICE_DRAW_BUFFER_MS + 1, INVOICE_DRAW_BUFFER_MS + 86400_000]) {
      expect(invoiceWarning([draw(previous)], at, new Date(announcement + offset))).toMatch(/可能不是最新.*新一期開獎資料可能尚未收錄/);
      expect(invoiceWarning([draw(previous), draw(expected)], '2000-01-01T00:00:00Z', new Date(announcement + offset))).toBe('');
    }
  });
  it('does not use successful fetch age or an intentionally queried historical period as a plain day limit', () => {
    expect(invoiceWarning([draw({ rocYear: 115, evenMonth: 8 })], '2000-01-01T00:00:00Z', new Date('2026-11-24T23:59:59+08:00'))).toBe('');
    expect(invoiceWarning([], at, new Date(at))).toBe('');
  });
});

it('reads new/legacy heartbeat success clocks, rejects invalid state, and allows timestamp fallback', async () => {
  const read = (raw: unknown, field?: string, legacy?: string) => readSuccessAt({ get: async () => raw === null ? null : JSON.stringify(raw) } as unknown as KVNamespace, 'key', field, legacy);
  expect(await read({ v: 1, lastSuccessAt: at })).toBe(at);
  expect(await read({ v: 1, lastSuccessAt: at }, 'dividendsLastSuccessAt', 'lastSuccessAt')).toBe(at);
  expect(await read({ v: 1, lastSuccessAt: '2000-01-01T00:00:00Z', dividendsLastSuccessAt: at }, 'dividendsLastSuccessAt', 'lastSuccessAt')).toBe(at);
  for (const raw of [null, {}, { v: 2, lastSuccessAt: at }, { v: 1, lastSuccessAt: 'bad' }, { v: 1, lastSuccessAt: '123' }, { v: 1, lastSuccessAt: '2026-02-30T00:00:00Z' }]) expect(await read(raw)).toBeUndefined();
});

it('keeps a snapshot missing the previous draw stale during the next draw grace period', () => {
  for (const time of ['2026-11-25T00:00:00+08:00', '2026-11-28T00:00:00+08:00']) {
    expect(invoiceWarning([draw({ rocYear: 115, evenMonth: 6 })], at, new Date(time))).toContain('115年07-08月新一期');
    expect(invoiceWarning([draw({ rocYear: 115, evenMonth: 8 })], at, new Date(time))).toBe('');
  }
});
