import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { formatAmount, formatCheckResult, formatWinningNumbers } from '../src/core/invoice/format.js';
import { parseInvoiceFeed } from '../src/core/invoice/parse.js';
import { checkNumber } from '../src/core/invoice/match.js';
import { parseQuotes } from '../src/core/stock/parse.js';
import { formatStockQuote, quoteStalenessNote } from '../src/core/stock/format.js';
import { fixture } from './stock-fixtures.js';
const draw = parseInvoiceFeed(readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8'))[0];
const clock = () => new Date('2026-10-26T00:00:00+08:00');
it('formats winning numbers and claim period without an empty extra prize line', () => {
  const value = formatWinningNumbers(draw, clock);
  expect(value).toContain('特別獎：89996565');
  expect(value).toContain('領獎期間：115年10月06日 ～ 116年01月05日');
  expect(value).toContain('開獎日：115年09月25日');
  expect(value).not.toContain('增開六獎');
  expect(value).toContain('二獎～六獎：末7～末3碼對頭獎，獎金依序為 4萬／1萬／4千／1千／200元。\n稅：三獎以上扣 20% 所得稅；五獎以上領獎扣 0.4% 印花稅，匯入帳戶免。');
  expect(formatWinningNumbers({ ...draw, extraSixth: ['123'] }, clock)).toContain('增開六獎：123');
});
it.each([[10000000, '1,000 萬元'], [2000000, '200 萬元'], [200000, '20 萬元'], [40000, '4 萬元'], [10000, '1 萬元'], [4000, '4,000 元'], [1000, '1,000 元'], [200, '200 元']])('formats %i', (amount, text) => expect(formatAmount(amount)).toBe(text));
it('explains partial wins and tax threshold', () => {
  const partial = formatCheckResult(draw, checkNumber('835', draw));
  expect(partial).toContain('至少中六獎 200 元，請對完整 8 碼看有沒有更大獎');
  expect(partial).not.toContain('只能判斷六獎，大獎要對完整 8 碼');
  expect(formatCheckResult(draw, checkNumber('00348835', draw))).toContain('提醒：三獎以上扣 20% 所得稅；五獎以上領獎扣 0.4% 印花稅，匯入帳戶免。');
  expect(formatCheckResult(draw, checkNumber('00048835', draw))).not.toContain('所得稅');
  const fifth = formatCheckResult(draw, checkNumber('00008835', draw));
  expect(fifth).toContain('提醒：五獎以上領獎扣 0.4% 印花稅，匯入帳戶免。');
  expect(fifth).not.toContain('所得稅');
  expect(formatCheckResult(draw, checkNumber('00000835', draw))).not.toContain('提醒：');
  expect(partial).not.toContain('提醒：');
});
it('keeps all formatted result types clean and human-readable', () => {
  const extraDraw = { ...draw, extraSixth: ['123'] };
  const values = [formatWinningNumbers(draw, clock), formatWinningNumbers(extraDraw, clock),
    ...['89996565', '91098182', '54348835', '04348835', '00348835', '00048835', '00008835', '00000835', '00000123', '00000000', '835', '48835', '123', '999', 'bad'].map(n => formatCheckResult(extraDraw, checkNumber(n, extraDraw)))];
  for (const value of values) {
    expect(value).toBe(value.trim());
    expect(value).not.toContain('\n\n\n');
    expect(value).not.toMatch(/undefined|null|\[object Object\]|NaN/);
    expect(value).not.toContain('{"');
    expect(() => JSON.parse(value)).toThrow();
  }
});
it.each(['上市', '上櫃'] as const)('labels differing ratio dates for %s and preserves absent fields and missing values', market => {
  const prefix = market === '上市' ? 'twse' : 'tpex';
  const quotes = fixture(`${prefix}-quotes`), ratios = fixture(`${prefix}-ratios`) as Record<string, string>[];
  const parse = (ratios: unknown) => parseQuotes(quotes, ratios, market).find(row => row.code === (market === '上市' ? '2330' : '6488'))!;
  const same = parse(ratios);
  expect(same).not.toHaveProperty('ratioDate');
  expect(formatStockQuote(same)).not.toContain('本益比資料日期');
  const different = parse(ratios.map(row => ({ ...row, Date: '1151028' })));
  expect(different.ratioDate).toEqual({ year: 2026, month: 10, day: 28 });
  expect(formatStockQuote(different)).toContain('（本益比資料日期 115年10月28日）');
  expect(formatStockQuote({ ...different, pe: null, yield: null, pb: null })).not.toContain('本益比資料日期');
  expect(formatStockQuote({ ...different, yield: null })).toContain('殖利率 —｜');
  for (const rows of [[], ratios.map(row => ({ ...row, Date: '1150230' }))]) {
    const quote = parse(rows);
    expect(quote).not.toHaveProperty('ratioDate');
    expect(formatStockQuote(quote)).not.toContain('本益比資料日期');
    if (!rows.length) expect(formatStockQuote(quote)).toContain('本益比 —｜殖利率 —｜股價淨值比 —');
  }
});
it('uses a recent TPEx check only for stale TPEx quotes, with Taipei dates and a 72-hour boundary', () => {
  const quote = parseQuotes(fixture('tpex-quotes'), fixture('tpex-ratios'), '上櫃')[0];
  const now = () => new Date('2026-10-29T16:00:00Z');
  expect(quoteStalenessNote({ ...quote, date: { year: 2026, month: 10, day: 29 } }, now, { lastSuccessAt: '2026-10-29T08:00:00Z', dataDate: '2026-10-29' })).toBe('');
  for (const [checkedAt, label] of [['2026-10-28T16:00:00Z', '115年10月29日'], ['2026-10-26T16:00:00Z', '115年10月27日']]) {
    expect(quoteStalenessNote(quote, now, { lastSuccessAt: checkedAt, dataDate: '2026-10-22' })).toBe(`（注意：上櫃資料停在 115年10月22日；${label} 已確認櫃買中心尚無更新資料，可能為休市）`);
  }
  for (const checkedAt of [undefined, 'invalid', '2026-10-26T15:59:59Z', '2026-10-30T00:00:00Z']) {
    expect(quoteStalenessNote(quote, now, checkedAt === undefined ? undefined : { lastSuccessAt: checkedAt, dataDate: '2026-10-22' })).toBe('（注意：上櫃資料停在 115年10月22日，可能尚未更新）');
  }
  expect(quoteStalenessNote({ ...quote, market: '上市' }, now, { lastSuccessAt: now().toISOString(), dataDate: '2026-10-22' })).toBe('（注意：上市資料停在 115年10月22日，可能尚未更新）');
});
it('uses the generic stale note when the TPEx heartbeat data date differs from the served quote', () => {
  const quote = parseQuotes(fixture('tpex-quotes'), fixture('tpex-ratios'), '上櫃')[0];
  const now = () => new Date('2026-10-29T16:00:00Z');
  for (const dataDate of ['2026-10-23', '2026-10-21']) {
    expect(quoteStalenessNote(quote, now, { lastSuccessAt: now().toISOString(), dataDate })).toBe('（注意：上櫃資料停在 115年10月22日，可能尚未更新）');
  }
});
it.each([
  { now: '2026-10-30T11:00:00Z', delayed: true },
  { now: '2026-10-30T10:00:00Z', delayed: true },
  { now: '2026-10-30T09:59:00Z', delayed: false },
  { now: '2026-10-30T11:00:00Z', dataDate: '2026-10-30', delayed: false },
  { now: '2026-10-30T11:00:00Z', lastSuccessAt: '2026-10-30T10:47:00Z', delayed: false },
  { now: '2026-10-30T11:00:00Z', lastSuccessAt: '2026-10-29T16:00:00Z', delayed: false },
  { now: '2026-10-30T11:00:00Z', market: '上市' as const, delayed: false },
  { now: '2026-10-31T11:00:00Z', delayed: true },
  { now: '2026-11-01T11:00:00Z', delayed: true },
  { now: '2026-11-02T09:59:00Z', dataDate: '2026-10-30', delayed: false },
  { now: '2026-11-02T10:00:00Z', dataDate: '2026-10-30', delayed: true },
])('shows the TPEx delay line only after the expected weekday: %j', ({ now, dataDate = '2026-10-29', lastSuccessAt = '2026-10-29T10:47:00Z', market = '上櫃', delayed }) => {
  const quote = { ...parseQuotes(fixture('tpex-quotes'), fixture('tpex-ratios'), '上櫃')[0], market, date: { year: 2026, month: 10, day: 29 } };
  const check = { dataDate, lastSuccessAt }, clock = () => new Date(now);
  const text = formatStockQuote(quote, clock, check);
  expect(text.includes('⚠️ 櫃買資料可能延遲')).toBe(delayed);
  if (delayed) expect(text).toContain('⚠️ 櫃買資料可能延遲，最近一次更新：2026-10-29 18:47（台北時間）');
  expect(formatStockQuote(quote, clock)).not.toContain('⚠️');
  expect(formatStockQuote(quote, undefined, check)).not.toContain('⚠️');
});
it('keeps the existing staleness note without adding a second TPEx warning', () => {
  const quote = parseQuotes(fixture('tpex-quotes'), fixture('tpex-ratios'), '上櫃')[0];
  const text = formatStockQuote(quote, () => new Date('2026-10-30T11:00:00Z'), { dataDate: '2026-10-22', lastSuccessAt: '2026-10-22T10:47:00Z' });
  expect(text).toContain('可能尚未更新');
  expect(text).not.toContain('⚠️');
});
