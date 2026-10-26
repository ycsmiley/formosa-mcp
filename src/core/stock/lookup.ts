export const normalizeStockQuery = (s: string) => s.trim().replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toUpperCase();
export type StockIdentity = { code: string; name: string; market: '上市' | '上櫃'; value?: number | null };
export type StockLookup<T> = { kind: 'one'; stock: T } | { kind: 'many'; stocks: T[] } | { kind: 'none' };
export function findStocks<T extends StockIdentity>(query: string, quotes: T[]): StockLookup<T> {
  const q = normalizeStockQuery(query);
  if (!q) throw new Error('請輸入股票代號（例如 2330）或名稱（例如 台積電）。');
  const exactCode = quotes.find(s => normalizeStockQuery(s.code) === q);
  if (exactCode) return { kind: 'one', stock: exactCode };
  const exact = quotes.filter(s => normalizeStockQuery(s.name) === q);
  if (exact.length === 1) return { kind: 'one', stock: exact[0] };
  const tier = (s: T) => normalizeStockQuery(s.name) === q ? 1 : normalizeStockQuery(s.name).startsWith(q) ? 2 : 3;
  const matches = quotes.filter(s => normalizeStockQuery(s.name).includes(q)).sort((a, b) =>
    tier(a) - tier(b) || (b.value ?? -Infinity) - (a.value ?? -Infinity));
  return matches.length === 1 ? { kind: 'one', stock: matches[0] } : matches.length ? { kind: 'many', stocks: matches } : { kind: 'none' };
}
