import { encodeQuotesSnapshot, encodeSnapshot, type MarketSnapshot } from '../core/snapshot.js';
import type { StockQuote } from '../core/stock/parse.js';

export const keys = { invoice: 'invoice:v1', twseQuotes: 'stock:quotes:twse:v1', tpexQuotes: 'stock:quotes:tpex:v1', twseDividends: 'stock:dividends:twse:v1', tpexDividends: 'stock:dividends:tpex:v1' };
export const metaKeys = { twse: 'stock:meta:twse:v1' };
export const collectKeys = { tpex: 'stock:collect:tpex:v1' };
export const minimumRows = { twse: 100, tpex: 50, invoice: 1 };
export const isQuotes = (key: string) => key === keys.twseQuotes || key === keys.tpexQuotes;

export function encodeStoredSnapshot(key: string, snapshot: { updatedAt: string }): string {
  const stable = { ...snapshot, updatedAt: '' };
  return isQuotes(key) ? encodeQuotesSnapshot(stable as MarketSnapshot<StockQuote>) : encodeSnapshot(stable);
}

export const snapshotUsageKey = (month: string) => `tdx:snapshot-usage:${month}`;
