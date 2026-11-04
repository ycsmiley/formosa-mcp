import { expect, it } from 'vitest';
import { buildMarketSummary, formatMarketSummary } from '../src/core/stock/market.js';
import { decodeMarketSummary } from '../src/core/stock/market-schema.js';
import { marketInput } from './stock-fixtures.js';

it.each([
  ['dataDate', undefined], ['dataDate', {}], ['dataDate', { year: 2026, month: 2, day: 30 }],
  ['dataDate', { year: '2026', month: 11, day: 3 }], ['dataDate', { year: 2026, month: 11, day: 3.5 }],
  ['taiex', undefined], ['taiex', '345.52'], ['taiex', NaN], ['taiex', 0],
  ['change', undefined], ['change', '-23.72'], ['change', Infinity],
  ['value', undefined], ['value', '1000'], ['value', -1],
  ['margin', null], ['margin', {}], ['marginReason', {}],
])('drops a market with invalid %s = %j, preserving the other market', (field, value) => {
  const summary = buildMarketSummary(marketInput());
  const decoded = decodeMarketSummary({ ...summary, tpex: { ...summary.tpex, [field]: value } });
  expect(decoded.tpex).toBeUndefined();
  expect(decoded.twse).toBe(summary.twse);
  expect(formatMarketSummary(decoded, () => new Date('2026-11-04T04:00:00Z'))).toContain('上櫃\n暫不提供。');
});

it.each([
  ['date', undefined], ['date', { year: 2026, month: 13, day: 1 }],
  ['dateConfirmed', undefined], ['dateConfirmed', 'true'],
  ['financePrev', undefined], ['financePrev', '100'],
  ['finance', undefined], ['finance', NaN],
  ['shortPrev', undefined], ['shortPrev', -1],
  ['short', undefined], ['short', 1.5], ['reason', {}],
])('drops a market with invalid margin %s = %j', (field, value) => {
  const summary = buildMarketSummary(marketInput());
  const decoded = decodeMarketSummary({ ...summary,
    tpex: { ...summary.tpex, margin: { ...summary.tpex!.margin, [field]: value } } });
  expect(decoded.tpex).toBeUndefined();
  expect(decoded.twse).toBe(summary.twse);
});

it('allows unavailable or unconfirmed margin and keeps the index usable', () => {
  const summary = buildMarketSummary(marketInput());
  delete summary.twse!.margin;
  summary.twse!.marginReason = '無法確認日期';
  summary.tpex!.margin!.dateConfirmed = false;
  summary.tpex!.margin!.reason = '無法確認日期';
  expect(decodeMarketSummary(summary)).toEqual(summary);
});

it('validates previous blocks before comparing dates or retaining failed markets', () => {
  const summary = buildMarketSummary(marketInput());
  const previous = { ...summary, twse: { ...summary.twse, dataDate: { year: 2026, month: 11, day: 4 }, value: 'bad' } };
  expect(buildMarketSummary(marketInput(), previous).twse).toEqual(summary.twse);
  expect(buildMarketSummary({ ...marketInput(), fmtqik: [] }, previous).twse).toBeUndefined();
});
