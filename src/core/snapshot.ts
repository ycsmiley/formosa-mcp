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
  const markets = snapshot as Partial<StockMarketSnapshot<StockQuote>>;
  if ([markets.twse, markets.tpex].some(rows => rows?.some(row => 'close' in row))) {
    const pack = (rows: StockQuote[] | null | undefined) => {
      if (!rows?.length) return rows;
      const date = rows[0].date;
      const keys = [...new Set(rows.flatMap(Object.keys))].filter(k => !['market', 'date', 'changeNote'].includes(k));
      const outliers = rows.some(row => JSON.stringify(row.date) !== JSON.stringify(date));
      if (outliers) keys.push('date');
      if (rows.some(row => row.changeNote !== undefined)) keys.push('changeNote');
      return { k: keys, date, r: rows.map(row => {
        const values = keys.map(k => k === 'date' && JSON.stringify(row.date) === JSON.stringify(date) ? null : row[k as keyof StockQuote] ?? null);
        while (values.length && values.at(-1) === null) values.pop();
        return values;
      }) };
    };
    return JSON.stringify({ v: 2, d: { ...snapshot, twse: pack(markets.twse), tpex: pack(markets.tpex) } });
  }
  return JSON.stringify({ v: 1, d: snapshot }, (_key, value) => {
    if (Array.isArray(value) && value.length && value.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
      const keys = [...new Set(value.flatMap(Object.keys))];
      return { k: keys, r: value.map(r => keys.map(k => r[k] ?? null)) };
    }
    return value;
  });
}
export function decodeSnapshot<T>(encoded: string): T {
  // Quotes v2 shares market/date metadata; invoice and dividends retain v1.
  // Avoid a JSON reviver on the request path: it visits every tuple cell.
  const version = JSON.parse(encoded);
  if (version.v === 2 && version.d && ['twse', 'tpex'].every(p => p in version.d)) {
    for (const p of ['twse', 'tpex'] as const) {
      const table = version.d[p];
      if (!table || Array.isArray(table)) continue;
      version.d[p] = table.r.map((row: unknown[]) => {
        const quote: Record<string, unknown> = { market: p === 'twse' ? '上市' : '上櫃', date: table.date };
        table.k.forEach((key: string, i: number) => {
          if ((key === 'date' || key === 'changeNote') && row[i] == null) return;
          quote[key] = row[i] ?? null;
        });
        return quote;
      });
    }
    return version.d as T;
  }
  const data = version;
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
