import type { Clock } from './clock.js';
import { parseInvoiceFeed, type Draw } from './invoice/parse.js';
import { parseQuotes, parseDividends, type StockQuote, type DividendEvent } from './stock/parse.js';
import { stockUrls } from './stock/source.js';
import type { StockMarketSnapshot } from './stock/service.js';
export interface InvoiceSnapshot { updatedAt: string; draws: Draw[] }
export interface MarketSnapshot<T> { updatedAt: string; rows: T[] }
export interface StockSnapshot { quotes: MarketSnapshot<StockQuote> | null; dividends: MarketSnapshot<DividendEvent> | null }
export async function buildInvoiceSnapshot(fetchFeed: () => Promise<string>, clock: Clock = () => new Date()): Promise<InvoiceSnapshot> {
  return { updatedAt: clock().toISOString(), draws: parseInvoiceFeed(await fetchFeed()).map(({ period, special, grand, first, extraSixth }) => ({ period, special, grand, first, extraSixth })) };
}
export async function buildStockSnapshot(market: 'twse' | 'tpex', fetchJson: (url: string) => Promise<unknown>, clock: Clock = () => new Date()): Promise<StockSnapshot> {
  const updatedAt = clock().toISOString(), label = market === 'twse' ? '上市' : '上櫃';
  async function build<T>(parse: () => Promise<T[]>): Promise<MarketSnapshot<T> | null> {
    try { return { updatedAt, rows: await parse() }; } catch { return null; }
  }
  const [quotes, dividends] = await Promise.all([
    build(async () => { const [q, r] = await Promise.all([fetchJson(stockUrls[`${market}-quotes`]), fetchJson(stockUrls[`${market}-ratios`])]); return parseQuotes(q, r, label); }),
    build(async () => parseDividends(await fetchJson(stockUrls[`${market}-div`]), label)),
  ]);
  return { quotes, dividends };
}
export function mergeStockSnapshots<T>(twse: MarketSnapshot<T> | null, tpex: MarketSnapshot<T> | null, tpexCheckedAt?: string): StockMarketSnapshot<T> | null {
  if (!twse && !tpex) return null;
  return { updatedAt: twse && tpex ? (twse.updatedAt < tpex.updatedAt ? twse.updatedAt : tpex.updatedAt) : (twse ?? tpex)!.updatedAt, twse: twse?.rows ?? null, tpex: tpex?.rows ?? null, ...(tpexCheckedAt ? { tpexCheckedAt } : {}) };
}
// Quotes v3 stores one market, with shared market/date and a fixed field dictionary.
const quoteKeys = ['code', 'name', 'open', 'high', 'low', 'close', 'change', 'volumeShares', 'value', 'pe', 'yield', 'pb'] as const;
export function encodeQuotesSnapshot({ updatedAt, rows }: MarketSnapshot<StockQuote>): string {
  const date = rows[0]?.date, market = rows[0]?.market;
  const sameDate = (row: StockQuote) => row.date.year === date?.year && row.date.month === date.month && row.date.day === date.day;
  const keys: (keyof StockQuote)[] = [...quoteKeys];
  if (rows.some(row => !sameDate(row))) keys.push('date');
  if (rows.some(row => row.changeNote !== undefined)) keys.push('changeNote');
  if (rows.some(row => row.ratioDate !== undefined)) keys.push('ratioDate');
  return JSON.stringify({ v: 3, d: { updatedAt, market, date, k: keys, r: rows.map(row => {
    const values = keys.map(k => k === 'date' && sameDate(row) ? null : row[k] ?? null);
    while (values.length && values.at(-1) === null) values.pop();
    return values;
  }) } });
}
export function decodeQuotesSnapshot(encoded: string): MarketSnapshot<StockQuote> {
  // No JSON reviver: it would visit every tuple cell on the request path.
  const data = JSON.parse(encoded);
  if (data.v !== 3 || !data.d || !Array.isArray(data.d.k) || !Array.isArray(data.d.r)) throw new Error('Invalid quotes snapshot');
  const table = data.d;
  return { updatedAt: table.updatedAt, rows: table.r.map((row: unknown[]) => {
    const quote: Record<string, unknown> = { market: table.market, date: table.date };
    table.k.forEach((key: string, i: number) => {
      if ((key === 'date' || key === 'changeNote' || key === 'ratioDate') && row[i] == null) return;
      quote[key] = row[i] ?? null;
    });
    return quote as unknown as StockQuote;
  }) };
}
// Keyed-tuple v1 for invoice and dividends; never store upstream JSON keys.
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
  const data = JSON.parse(encoded);
  if (data.v !== 1 || !data.d || typeof data.d !== 'object') throw new Error('Invalid snapshot');
  function unpack(value: any): any {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value.k) && Array.isArray(value.r)) {
      return value.r.map((row: unknown[]) => Object.fromEntries(value.k.map((key: string, i: number) => [key, unpack(row[i])])));
    }
    if (Array.isArray(value)) return value.map(unpack);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]));
  }
  return unpack(data.d) as T;
}
