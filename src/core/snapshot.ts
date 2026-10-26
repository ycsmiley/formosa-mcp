import type { Clock } from './clock.js';
import { parseInvoiceFeed, type Draw } from './invoice/parse.js';
import { parseQuotes, parseDividends, type StockQuote, type DividendEvent } from './stock/parse.js';
import { stockUrls } from './stock/source.js';
import type { StockMarketSnapshot } from './stock/service.js';
export interface InvoiceSnapshot { updatedAt: string; draws: Draw[] }
export interface StockSnapshot { quotes: StockMarketSnapshot<StockQuote>; dividends: StockMarketSnapshot<DividendEvent> }
export async function buildInvoiceSnapshot(fetchFeed: () => Promise<string>, clock: Clock = () => new Date()): Promise<InvoiceSnapshot> {
  return { updatedAt: clock().toISOString(), draws: parseInvoiceFeed(await fetchFeed()).map(({ period, special, grand, first, extraSixth }) => ({ period, special, grand, first, extraSixth })) };
}
export async function buildStockSnapshot(fetchJson: (url: string) => Promise<unknown>, previous?: Partial<StockSnapshot>, clock: Clock = () => new Date()): Promise<StockSnapshot> {
  const updatedAt = clock().toISOString();
  async function build<T>(parse: (p: 'twse' | 'tpex') => Promise<T[]>, old?: StockMarketSnapshot<T>): Promise<StockMarketSnapshot<T>> {
    const [twse, tpex] = await Promise.all((['twse', 'tpex'] as const).map(async p => { try { return await parse(p); } catch { return old?.[p] ?? null; } }));
    return { updatedAt, twse, tpex };
  }
  const [quotes, dividends] = await Promise.all([
    build(async p => { const [q, r] = await Promise.all([fetchJson(stockUrls[`${p}-quotes`]), fetchJson(stockUrls[`${p}-ratios`])]); return parseQuotes(q, r, p === 'twse' ? '上市' : '上櫃'); }, previous?.quotes),
    build(async p => parseDividends(await fetchJson(stockUrls[`${p}-div`]), p === 'twse' ? '上市' : '上櫃'), previous?.dividends),
  ]);
  return { quotes, dividends };
}
// Rows use a single field dictionary per value, never upstream JSON keys.
export function encodeSnapshot<T extends object>(snapshot: T): string {
  return JSON.stringify({ v: 1, d: snapshot }, (_key, value) => {
    if (Array.isArray(value) && value.length && value.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
      const keys = [...new Set(value.flatMap(Object.keys))];
      return { k: keys, r: value.map(r => keys.map(k => r[k] ?? null)) };
    }
    return value;
  });
}
export function decodeSnapshot<T>(encoded: string): T {
  const data = JSON.parse(encoded, (_key, value) => value && Array.isArray(value.k) && Array.isArray(value.r) ? value.r.map((row: unknown[]) => Object.fromEntries(value.k.map((key: string, i: number) => [key, row[i]]))) : value);
  if (data.v !== 1 || !data.d || typeof data.d !== 'object') throw new Error('Invalid snapshot');
  return data.d as T;
}
