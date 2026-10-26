import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildInvoiceSnapshot, buildStockSnapshot, encodeSnapshot, decodeSnapshot } from '../src/core/snapshot.js';
import { createInvoiceService } from '../src/core/invoice/service.js';
import { createStockService } from '../src/core/stock/service.js';
import { stockFetch } from './stock-fixtures.js';
const xml = readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8');
it('uses the injected clock for snapshot timestamps', async () => {
  const updatedAt = '2026-10-27T01:02:03.000Z';
  const clock = () => new Date(updatedAt);
  const invoice = await buildInvoiceSnapshot(async () => xml, clock);
  const stock = await buildStockSnapshot(stockFetch, undefined, clock);
  expect([invoice.updatedAt, stock.quotes.updatedAt, stock.dividends.updatedAt]).toEqual([updatedAt, updatedAt, updatedAt]);
});
it('roundtrips slim snapshots and rejects unknown schema versions', async () => {
  const invoice = await buildInvoiceSnapshot(async () => xml);
  expect(decodeSnapshot(encodeSnapshot(invoice))).toEqual(invoice);
  expect(encodeSnapshot(invoice)).not.toMatch(/pubDate|sourceUrl|CDATA/);
  const stock = await buildStockSnapshot(stockFetch);
  const decoded = decodeSnapshot<typeof stock.quotes>(encodeSnapshot(stock.quotes));
  expect(decoded).toEqual(stock.quotes);
  expect(decodeSnapshot(encodeSnapshot(stock.dividends))).toEqual(stock.dividends);
  expect(encodeSnapshot(stock.quotes)).not.toMatch(/SecuritiesCompanyCode|ClosingPrice|TradingShares/);
  expect(() => decodeSnapshot('{"v":2,"d":{}}')).toThrow();
});
it('retains each previous market independently when sources fail', async () => {
  const previous = await buildStockSnapshot(stockFetch);
  const next = await buildStockSnapshot(async url => { if (url.includes('tpex')) throw new Error('private'); return stockFetch(url); }, previous);
  expect(next.quotes.tpex).toEqual(previous.quotes.tpex);
  expect(next.dividends.tpex).toEqual(previous.dividends.tpex);
  const partial = await buildStockSnapshot(async url => { if (url.includes('tpex')) throw new Error('private'); return stockFetch(url); });
  expect(partial.quotes.tpex).toBeNull();
  const service = createStockService({ snapshot: { quotes: async () => partial.quotes, dividends: async () => partial.dividends } });
  expect((await service.quote('2330')).text).toContain('（櫃買中心資料暫時取不到）');
  expect((await service.dividends()).text).toContain('（櫃買中心資料暫時取不到）');
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

it('roundtrips quote date outliers, empty/unavailable markets and trailing nulls', async () => {
  const { quotes } = await buildStockSnapshot(stockFetch);
  const row = quotes.twse![0];
  for (const twse of [[], null, [row, { ...row, date: { year: 2025, month: 1, day: 2 }, pe: null, yield: null, pb: null }]]) {
    const snapshot = { ...quotes, twse };
    expect(decodeSnapshot(encodeSnapshot(snapshot))).toEqual(snapshot);
  }
});
