import { expect, it, vi } from 'vitest';
import * as stockParse from '../src/core/stock/parse.js';
import { parseNumber, parseRocDate, rocDateLabel, parseQuotes, parseDividends } from '../src/core/stock/parse.js';
import { findStocks } from '../src/core/stock/lookup.js';
import { formatStockQuote, formatStockDividends, formatStockLookup } from '../src/core/stock/format.js';
import { createStockService } from '../src/core/stock/service.js';
import { fetchJson, stockUrls } from '../src/core/stock/source.js';
import { fixture, stockFetch } from './stock-fixtures.js';
const clock = () => new Date('2026-10-26T12:00:00+08:00');
const tw = parseQuotes(fixture('twse-quotes'), fixture('twse-ratios'), '上市');
const tp = parseQuotes(fixture('tpex-quotes'), fixture('tpex-ratios'), '上櫃');
const div = [...parseDividends(fixture('twse-div'), '上市'), ...parseDividends(fixture('tpex-div'), '上櫃')];
it('parses defensive numeric strings and valid ROC dates', () => {
  for (const value of ['', '--', ' --- ', 'N/A', '尚未公告', '除息', 'Infinity']) expect(parseNumber(value)).toBeNull();
  expect(parseNumber(' +1,234.50 ')).toBe(1234.5);
  expect(parseNumber('-54.00 ')).toBe(-54);
  expect(parseRocDate('1151022')).toEqual({ year: 2026, month: 10, day: 22 });
  expect(rocDateLabel(parseRocDate('1151022')!)).toBe('115年10月22日');
  for (const date of ['1150230', '1151301', 'bad']) expect(parseRocDate(date)).toBeNull();
});
it('excludes warrants, merges ratios, and preserves ex-dividend notes', () => {
  expect(tp.some(s => /^7\d{5}$/.test(s.code))).toBe(false);
  expect(tp.find(s => s.code === '00719B')).toMatchObject({ change: null, changeNote: '除息' });
  expect(tw.find(s => s.code === '2330')).toMatchObject({ pe: 27.65, yield: 0.92, pb: 9.61 });
  expect(div.every(e => ['除息', '除權', '除權息'].includes(e.type))).toBe(true);
});
it('resolves code then exact name then partial names with normalized input', () => {
  expect(findStocks('２３３０', tw)).toMatchObject({ kind: 'one', stock: { code: '2330' } });
  expect(findStocks('00400a', tw)).toMatchObject({ kind: 'one', stock: { code: '00400A' } });
  expect(findStocks('台積電', tw)).toMatchObject({ kind: 'one', stock: { code: '2330' } });
  expect(findStocks('國泰', tw).kind).toBe('many');
  expect(findStocks('zzzz', tw).kind).toBe('none');
  expect(() => findStocks(' ', tw)).toThrow('請輸入');
  const stocks = [{ code: 'A', name: 'B', market: '上市' as const }, { code: 'B', name: 'BB', market: '上市' as const }];
  expect(findStocks('B', stocks)).toMatchObject({ kind: 'one', stock: { code: 'B' } });
  expect(findStocks('BB', stocks)).toMatchObject({ kind: 'one', stock: { code: 'B' } });
});
it('formats exact TWSE and TPEx quote blocks', () => {
  expect(formatStockQuote(tw.find(s => s.code === '2330')!)).toBe(`台積電（2330）｜上市
資料日期：115年10月22日（盤後資料，非即時）
收盤 2,385.00｜漲跌 -35.00（-1.45%）
開盤 2,435.00｜最高 2,435.00｜最低 2,385.00
成交量 29,797 張｜成交金額 715.37 億元
本益比 27.65｜殖利率 0.92%｜股價淨值比 9.61
資料來源：臺灣證券交易所 OpenAPI`);
  expect(formatStockQuote(tp.find(s => s.code === '6488')!)).toBe(`環球晶（6488）｜上櫃
資料日期：115年10月22日（盤後資料，非即時）
收盤 826.00｜漲跌 -54.00（-6.14%）
開盤 896.00｜最高 898.00｜最低 815.00
成交量 10,521 張｜成交金額 89.64 億元
本益比 40.10｜殖利率 0.93%｜股價淨值比 4.08
資料來源：證券櫃檯買賣中心 OpenAPI`);
});
it('formats no trades and ex-dividend change without a percentage', () => {
  for (const s of [tw.find(s => s.code === '00625K')!, tp.find(s => s.code === '020001')!]) {
    expect(formatStockQuote(s)).toContain('當日無成交');
    expect(formatStockQuote(s)).not.toContain('開盤');
  }
  expect(formatStockQuote(tp.find(s => s.code === '00719B')!)).toContain('漲跌 除息（不計漲跌）\n');
});
it('sorts, limits and filters upcoming dividends using Taipei today', () => {
  const text = formatStockDividends(div, clock, undefined, 3);
  expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(3);
  expect(text).toContain('115年10月26日起');
  expect(text).not.toMatch(/115年(?:0[1-9]月|10月(?:0\d|1\d|2[0-5])日)/);
  const dates = text.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2, 13));
  expect(dates).toEqual([...dates].sort());
});
it('shares each dataset cache across tools and expires after one hour', async () => {
  let now = clock().getTime();
  const fetch = vi.fn(stockFetch), service = createStockService({ fetchJson: fetch, clock: () => new Date(now) });
  await service.quote('2330'); await service.dividends('2330'); await service.quote('6488'); await service.dividends();
  expect(fetch).toHaveBeenCalledTimes(6);
  now += 3599999; await service.dividends('2330'); expect(fetch).toHaveBeenCalledTimes(6);
  now++; await service.dividends('2330'); expect(fetch).toHaveBeenCalledTimes(12);
});
it('caches parsed market results across calls and tools for one hour', async () => {
  let now = clock().getTime();
  const quotes = vi.spyOn(stockParse, 'parseQuotes');
  const dividends = vi.spyOn(stockParse, 'parseDividends');
  const service = createStockService({ fetchJson: stockFetch, clock: () => new Date(now) });
  try {
    await service.quote('2330');
    await service.quote('6488');
    await service.dividends('2330');
    await service.dividends();
    expect(quotes).toHaveBeenCalledTimes(2);
    expect(dividends).toHaveBeenCalledTimes(2);
    now += 3599999;
    await service.dividends('2330');
    expect(quotes).toHaveBeenCalledTimes(2);
    expect(dividends).toHaveBeenCalledTimes(2);
    now++;
    await service.dividends('2330');
    expect(quotes).toHaveBeenCalledTimes(4);
    expect(dividends).toHaveBeenCalledTimes(4);
  } finally { quotes.mockRestore(); dividends.mockRestore(); }
});
it('resolves schedule-only ETFs and stocks with no upcoming events', async () => {
  const service = createStockService({ fetchJson: stockFetch, clock });
  const e = div.find(e => e.date.month >= 11)!;
  expect((await service.dividends(e.code)).text).toContain(`${e.name}（${e.code}）近期除權息`);
  expect((await service.dividends('2330')).text).toContain('台積電（2330）目前沒有已公告的近期除權息。');
});
it.each(['twse', 'tpex'])('answers with a partial %s outage', async prefix => {
  const service = createStockService({ clock, fetchJson: async url => {
    if (url === stockUrls[`${prefix}-quotes`] || url === stockUrls[`${prefix}-div`]) throw new Error('offline');
    return stockFetch(url);
  } });
  const r = await service.quote(prefix === 'twse' ? '6488' : '2330');
  expect(r.isError).toBe(false); expect(r.text).toContain(prefix === 'twse' ? '（證交所資料暫時取不到）' : '（櫃買中心資料暫時取不到）');
  expect((await service.dividends()).isError).toBe(false);
});
it('retries failed markets while retaining successful datasets and parsed results', async () => {
  let offline = true;
  const fetch = vi.fn(async (url: string) => {
    if (offline && url === stockUrls['tpex-quotes']) throw new Error('offline');
    return stockFetch(url);
  });
  const service = createStockService({ fetchJson: fetch, clock });
  expect((await service.quote('2330')).text).toContain('（櫃買中心資料暫時取不到）');
  offline = false;
  const recovered = await service.quote('6488');
  expect(recovered.text).toContain('環球晶（6488）');
  expect(recovered.text).not.toContain('資料暫時取不到');
  await service.dividends('6488');
  for (const url of Object.values(stockUrls)) {
    expect(fetch.mock.calls.filter(([called]) => called === url)).toHaveLength(url === stockUrls['tpex-quotes'] ? 2 : 1);
  }
});
it('handles total outages and validates empty input before fetching', async () => {
  const fetch = vi.fn(async () => { throw new Error('offline'); });
  const service = createStockService({ fetchJson: fetch });
  expect((await service.quote(' ')).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
  for (const r of [await service.quote('2330'), await service.dividends()]) {
    expect(r.isError).toBe(true); expect(r.text).toContain('目前連不到證交所／櫃買中心資料來源');
  }
});
it('uses global fetch with a timeout and rejects HTTP errors', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fake = vi.fn().mockResolvedValueOnce(new Response('[]')).mockResolvedValueOnce(new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fake);
  try {
    expect(await fetchJson('https://example.com')).toEqual([]);
    expect(timeout).toHaveBeenCalledWith(45_000);
    expect(fake).toHaveBeenCalledWith('https://example.com', { signal: expect.any(AbortSignal) });
    await expect(fetchJson('https://example.com')).rejects.toThrow('HTTP 503');
  } finally { vi.unstubAllGlobals(); timeout.mockRestore(); }
});
it('formats dividend amounts, weekdays, subscriptions and unannounced cash', () => {
  const text = formatStockDividends(div, clock, undefined, 100);
  expect(text).toContain('115年10月27日（二）永豐優息存股（00907）上市｜除息｜現金股利 0.268 元');
  expect(text).toContain('115年11月06日（五）精技（2414）上市｜除權｜現金增資認購率 0.12365842、認購價尚未公告');
  expect(text).toContain('現金股利尚未公告');
  expect(text).toContain('無償配股率 0.09999999');
  expect(text).not.toMatch(/undefined|null|NaN|\{|\[object/);
});
it('uses today in Taipei and includes events dated today', () => {
  const event = div.find(e => e.code === '00907')!;
  expect(formatStockDividends([event], () => new Date('2026-10-26T16:00:00Z'))).toContain('共 1 筆');
  expect(formatStockDividends([event], () => new Date('2026-10-27T16:00:00Z'))).toContain('共 0 筆');
});
it('preserves nullable ratios and subscription fields from real feeds', () => {
  const rows = fixture('tpex-ratios') as Record<string, string>[];
  const missing = rows.find(r => r.PriceEarningRatio === 'N/A')!;
  expect(parseQuotes([{ Date: '1151022', SecuritiesCompanyCode: missing.SecuritiesCompanyCode, CompanyName: missing.CompanyName }], rows, '上櫃')[0].pe).toBeNull();
  const capital = div.find(e => e.code === '2414')!;
  expect(capital).toMatchObject({ type: '除權', stockRatio: null, subscriptionRatio: 0.12365842, subscriptionPrice: '尚未公告' });
  expect(parseDividends([{ Date: '1151027', Code: 'X', Name: '測試', Exdividend: '權息', CashDividend: '', StockDividendRatio: '0' }], '上市')[0]).toMatchObject({ type: '除權息', cash: null, stockRatio: null });
});

it('limits ambiguous selections to ten and formats friendly misses', () => {
  const stocks = Array.from({ length: 12 }, (_, i) => ({ code: String(i), name: `測試${i}`, market: '上市' as const }));
  const result = findStocks('測試', stocks);
  if (result.kind === 'one') throw new Error('Expected multiple');
  const text = formatStockLookup('測試', result);
  expect(text).toContain('找到 12 檔符合「測試」的股票，請指定代號：');
  expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(10);
  expect(text).toContain('…另有 2 檔');
  expect(formatStockLookup('zz', { kind: 'none' })).toBe('找不到「zz」，請輸入股票代號（例如 2330）或名稱（例如 台積電）。');
});
