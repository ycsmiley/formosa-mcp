import { TtlCache } from '../cache.js';
import type { Clock } from '../clock.js';
import { fetchJson as defaultFetchJson, stockUrls } from './source.js';
import { parseDividends, parseQuotes, type Market } from './parse.js';
import { findStocks, normalizeStockQuery, type StockIdentity } from './lookup.js';
import { formatStockDividends, formatStockLookup, formatStockQuote } from './format.js';
export interface StockResult { text: string; isError: boolean }
export interface StockServiceOptions {
  fetchJson?: (url: string) => Promise<unknown>;
  clock?: Clock;
  cache?: { getOrLoad(key: string, loader: () => Promise<unknown>): Promise<unknown> };
}
export function createStockService({ fetchJson = defaultFetchJson, clock = () => new Date(), cache = new TtlCache<unknown>(3600000, () => clock().getTime()) }: StockServiceOptions = {}) {
  const load = (key: keyof typeof stockUrls) => cache.getOrLoad(key, () => fetchJson(stockUrls[key]));
  const quoteCache = new TtlCache<ReturnType<typeof parseQuotes>>(3600000, () => clock().getTime());
  const dividendCache = new TtlCache<ReturnType<typeof parseDividends>>(3600000, () => clock().getTime());
  async function markets<T>(loader: (prefix: 'twse' | 'tpex', market: Market) => Promise<T[]>) {
    const results = await Promise.allSettled([loader('twse', '上市'), loader('tpex', '上櫃')]);
    if (results.every(r => r.status === 'rejected')) throw new Error(results.map(r => r.status === 'rejected' ? String(r.reason instanceof Error ? r.reason.message : r.reason) : '').join('；'));
    return { rows: results.flatMap(r => r.status === 'fulfilled' ? r.value : []), warning: results.map((r, i) => r.status === 'rejected' ? `（${i ? '櫃買中心' : '證交所'}資料暫時取不到）` : '').filter(Boolean).join('\n') };
  }
  const quotes = () => markets((p, market) => quoteCache.getOrLoad(p, async () => {
    const [q, r] = await Promise.all([load(`${p}-quotes`), load(`${p}-ratios`)]);
    return parseQuotes(q, r, market);
  }));
  const safely = async (query: string | undefined, action: () => Promise<{ text: string; warning: string }>): Promise<StockResult> => {
    if (query !== undefined && !normalizeStockQuery(query)) return { text: '請輸入股票代號（例如 2330）或名稱（例如 台積電）。', isError: true };
    try { const r = await action(); return { text: [r.text, r.warning].filter(Boolean).join('\n'), isError: false }; }
    catch (error) { return { text: `目前連不到證交所／櫃買中心資料來源，請稍後再試（錯誤：${error instanceof Error ? error.message : String(error)}）`, isError: true }; }
  };
  return {
    quote(query: string) { return safely(query, async () => {
      const { rows, warning } = await quotes(), found = findStocks(query, rows);
      return { text: found.kind === 'one' ? formatStockQuote(found.stock) : formatStockLookup(query, found), warning };
    }); },
    dividends(query?: string) { return safely(query, async () => {
      const div = await markets((p, market) => dividendCache.getOrLoad(p, async () => parseDividends(await load(`${p}-div`), market)));
      if (query === undefined) return { text: formatStockDividends(div.rows, clock), warning: div.warning };
      // A schedule can still resolve ETFs absent from the quote feed, even during a quote outage.
      const q = await quotes().catch(() => ({ rows: [], warning: '（行情資料暫時取不到）' }));
      const identities: StockIdentity[] = [...q.rows];
      for (const e of div.rows) if (!identities.some(s => s.code === e.code && s.market === e.market)) identities.push(e);
      const found = findStocks(query, identities);
      return { text: found.kind === 'one' ? formatStockDividends(div.rows, clock, found.stock) : formatStockLookup(query, found), warning: [...new Set([div.warning, q.warning].filter(Boolean))].join('\n') };
    }); },
  };
}
