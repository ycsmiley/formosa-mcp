import { expect, it } from 'vitest';
import { quoteStalenessNote } from '../src/core/stock/format.js';
import { formatMarketSummary } from '../src/core/stock/market.js';
import { parseQuotes, type StockDate } from '../src/core/stock/parse.js';
import { fixture } from './stock-fixtures.js';
const quote = (date: StockDate) => ({ ...parseQuotes(fixture('tpex-quotes'), fixture('tpex-ratios'), '上櫃')[0], date });
const market = (date: StockDate, now: string) => formatMarketSummary({ fetchedAt: now, twse: { dataDate: date, taiex: 20000, change: 100, value: 100000000 } }, () => new Date(now));
it('retains Feb 11 data over the Feb 12–20 TWSE closure through Feb 23 evening', () => {
  const date = { year: 2026, month: 2, day: 11 }, now = '2026-02-23T19:00:00+08:00';
  expect(quoteStalenessNote(quote(date), () => new Date(now))).toBe('');
  expect(market(date, now)).not.toContain('資料停在');
});
it('TPEx expected-date walk-back skips the full holiday closure', () => {
  const date = { year: 2026, month: 2, day: 11 }, check = { dataDate: '2026-02-11', lastSuccessAt: '2026-02-11T10:47:00Z' };
  for (const now of ['2026-02-20T19:00:00+08:00', '2026-02-23T17:00:00+08:00']) expect(quoteStalenessNote(quote(date), () => new Date(now), check)).toBe('');
  expect(quoteStalenessNote(quote(date), () => new Date('2026-02-23T19:00:00+08:00'), check)).toContain('櫃買資料可能延遲');
});
it('still warns for ordinary weekday gaps', () => {
  const date = { year: 2026, month: 3, day: 2 }, now = '2026-03-06T19:00:00+08:00';
  expect(quoteStalenessNote(quote(date), () => new Date(now))).toContain('資料停在'); expect(market(date, now)).toContain('資料停在');
});
it('falls back to weekdays outside bundled calendar coverage', () => {
  const date = { year: 2025, month: 2, day: 3 }, now = '2025-02-07T19:00:00+08:00';
  expect(quoteStalenessNote(quote(date), () => new Date(now))).toContain('資料停在'); expect(market(date, now)).toContain('資料停在');
  const friday = { year: 2025, month: 2, day: 7 }; expect(quoteStalenessNote(quote(friday), () => new Date('2025-02-10T17:00:00+08:00'), { dataDate: '2025-02-07', lastSuccessAt: '2025-02-07T10:47:00Z' })).toBe('');
});
it('only prints the trading-session notice on bundled open days, with weekday fallback', () => {
  const date = { year: 2026, month: 2, day: 11 };
  expect(market(date, '2026-02-20T10:00:00+08:00')).not.toContain('這是前一個交易日收盤資料');
  expect(market(date, '2026-02-23T10:00:00+08:00')).toContain('這是前一個交易日收盤資料');
  expect(market(date, '2025-02-07T10:00:00+08:00')).toContain('這是前一個交易日收盤資料');
});
