import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { buildInvoiceSnapshot, buildStockSnapshot, mergeStockSnapshots, encodeQuotesSnapshot, decodeQuotesSnapshot, encodeSnapshot, decodeSnapshot } from '../src/core/snapshot.js';
import { createInvoiceService } from '../src/core/invoice/service.js';
import { createStockService } from '../src/core/stock/service.js';
import { stockUrls } from '../src/core/stock/source.js';
import { stockFetch } from './stock-fixtures.js';
const xml = readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8');
it('uses the injected clock and fetches only the selected market', async () => {
  const updatedAt = '2026-10-27T01:02:03.000Z', clock = () => new Date(updatedAt);
  const invoice = await buildInvoiceSnapshot(async () => xml, clock);
  for (const market of ['twse', 'tpex'] as const) {
    const fetch = vi.fn(stockFetch);
    const stock = await buildStockSnapshot(market, fetch, clock);
    expect([invoice.updatedAt, stock.quotes!.updatedAt, stock.dividends!.updatedAt]).toEqual([updatedAt, updatedAt, updatedAt]);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(Object.entries(stockUrls).filter(([key]) => key.startsWith(market)).map(([, url]) => url).sort());
  }
});
it('roundtrips explicit encoders and rejects unknown or wrong schemas', async () => {
  const invoice = await buildInvoiceSnapshot(async () => xml);
  expect(decodeSnapshot(encodeSnapshot(invoice))).toEqual(invoice);
  expect(encodeSnapshot(invoice)).not.toMatch(/pubDate|sourceUrl|CDATA/);
  for (const market of ['twse', 'tpex'] as const) {
    const stock = await buildStockSnapshot(market, stockFetch);
    expect(decodeQuotesSnapshot(encodeQuotesSnapshot(stock.quotes!))).toEqual(stock.quotes);
    expect(decodeSnapshot(encodeSnapshot(stock.dividends!))).toEqual(stock.dividends);
    expect(encodeQuotesSnapshot(stock.quotes!)).not.toMatch(/SecuritiesCompanyCode|ClosingPrice|TradingShares/);
    expect(() => decodeSnapshot(encodeQuotesSnapshot(stock.quotes!))).toThrow();
    expect(() => decodeQuotesSnapshot(encodeSnapshot(stock.dividends!))).toThrow();
  }
  for (const raw of ['{"v":2,"d":{}}', '{"v":99,"d":{}}']) {
    expect(() => decodeSnapshot(raw)).toThrow();
    expect(() => decodeQuotesSnapshot(raw)).toThrow();
  }
});
it('fails quotes and dividends independently without any previous-value fallback', async () => {
  for (const failed of ['quotes', 'ratios', 'div']) {
    const data = await buildStockSnapshot('twse', async url => { if (url === stockUrls[`twse-${failed}` as keyof typeof stockUrls]) throw new Error('private'); return stockFetch(url); });
    expect(data.quotes === null).toBe(failed !== 'div');
    expect(data.dividends === null).toBe(failed === 'div');
  }
  expect(await buildStockSnapshot('tpex', async () => { throw new Error('private'); })).toEqual({ quotes: null, dividends: null });
});
it('merges market timestamps conservatively and preserves partial-market warnings', async () => {
  const twse = await buildStockSnapshot('twse', stockFetch, () => new Date('2026-10-26'));
  const tpex = await buildStockSnapshot('tpex', stockFetch, () => new Date('2026-10-27'));
  expect(mergeStockSnapshots(twse.quotes, tpex.quotes)).toMatchObject({ updatedAt: twse.quotes!.updatedAt, twse: twse.quotes!.rows, tpex: tpex.quotes!.rows });
  expect(mergeStockSnapshots(tpex.quotes, twse.quotes)!.updatedAt).toBe(twse.quotes!.updatedAt);
  expect(mergeStockSnapshots(null, null)).toBeNull();
  for (const missing of ['twse', 'tpex']) {
    const quotes = mergeStockSnapshots(missing === 'twse' ? null : twse.quotes, missing === 'tpex' ? null : tpex.quotes);
    const dividends = mergeStockSnapshots(missing === 'twse' ? null : twse.dividends, missing === 'tpex' ? null : tpex.dividends);
    expect(quotes!.updatedAt).toBe(missing === 'twse' ? tpex.quotes!.updatedAt : twse.quotes!.updatedAt);
    const service = createStockService({ snapshot: { quotes: async () => quotes, dividends: async () => dividends } });
    const warning = missing === 'twse' ? '（證交所資料暫時取不到）' : '（櫃買中心資料暫時取不到）';
    expect((await service.quote(missing === 'twse' ? '6488' : '2330')).text).toContain(warning);
    expect((await service.dividends()).text).toContain(warning);
  }
});
it('snapshot services hide errors while preserving validation and null messages', async () => {
  const fail = async (): Promise<never> => { throw new Error('secret detail'); };
  const invoice = createInvoiceService({ loadDraws: fail });
  expect((await invoice.check('54348835')).text).toBe('暫時無法取得資料，請稍後再試。');
  expect((await invoice.getWinningNumbers()).text).toBe('暫時無法取得資料，請稍後再試。');
  expect((await createInvoiceService({ loadDraws: async () => null }).getWinningNumbers()).text).toBe('資料更新中，請稍後再試');
  const stock = createStockService({ snapshot: { quotes: fail, dividends: fail } });
  for (const result of [await stock.quote('2330'), await stock.dividends()]) {
    expect(result).toEqual({ text: '暫時無法取得資料，請稍後再試。', isError: true });
  }
});
it('roundtrips quote date outliers, empty markets, change notes and trailing nulls', async () => {
  const { quotes } = await buildStockSnapshot('twse', stockFetch);
  const row = quotes!.rows[0];
  for (const rows of [[], [row, { ...row, date: { year: 2025, month: 1, day: 2 }, changeNote: '除息', pe: null, yield: null, pb: null }]]) {
    const snapshot = { ...quotes!, rows };
    expect(decodeQuotesSnapshot(encodeQuotesSnapshot(snapshot))).toEqual(snapshot);
  }
});
