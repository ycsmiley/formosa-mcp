export type StockDate = { year: number; month: number; day: number };
export type Market = '上市' | '上櫃';
export interface StockQuote {
  market: Market; code: string; name: string; date: StockDate;
  open: number | null; high: number | null; low: number | null; close: number | null;
  change: number | null; changeNote?: string; volumeShares: number | null; value: number | null;
  pe: number | null; yield: number | null; pb: number | null;
}
export interface DividendEvent {
  market: Market; code: string; name: string; date: StockDate; type: '除息' | '除權' | '除權息';
  cash: number | null; stockRatio: number | null;
  subscriptionRatio: number | '尚未公告' | null; subscriptionPrice: number | '尚未公告' | null;
}
export function parseNumber(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const value = s.replace(/[\s,]/g, '').replace(/^\+/, '');
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(+value) ? +value : null;
}
export function parseRocDate(s: string): StockDate | null {
  if (!/^\d{7}$/.test(s)) return null;
  const year = +s.slice(0, 3) + 1911, month = +s.slice(3, 5), day = +s.slice(5);
  const d = new Date(Date.UTC(year, month - 1, day));
  return year > 1911 && d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day ? { year, month, day } : null;
}
export const rocDateLabel = (d: StockDate) => `${d.year - 1911}年${String(d.month).padStart(2, '0')}月${String(d.day).padStart(2, '0')}日`;
type Row = Record<string, string>;
export function stockRows(data: unknown): Row[] {
  if (!Array.isArray(data) || data.some(r => !r || typeof r !== 'object' || Object.values(r).some(v => typeof v !== 'string'))) throw new Error('股票資料格式不正確');
  return data;
}
export function parseQuotes(data: unknown, ratios: unknown, market: Market): StockQuote[] {
  const tw = market === '上市', codeKey = tw ? 'Code' : 'SecuritiesCompanyCode';
  const byCode = new Map(stockRows(ratios).map(r => [r[codeKey], r]));
  return stockRows(data).flatMap(r => {
    const code = r[codeKey]?.trim(), date = parseRocDate(r.Date ?? '');
    if (!code || !date) return [];
    const ratio = byCode.get(code) ?? {}, n = (key: string) => parseNumber(r[key]);
    const change = n('Change'), note = r.Change?.trim();
    return [{ market, code, name: r[tw ? 'Name' : 'CompanyName'], date,
      open: n(tw ? 'OpeningPrice' : 'Open'), high: n(tw ? 'HighestPrice' : 'High'), low: n(tw ? 'LowestPrice' : 'Low'), close: n(tw ? 'ClosingPrice' : 'Close'),
      change, ...(change === null && note?.startsWith('除') ? { changeNote: note } : {}),
      volumeShares: n(tw ? 'TradeVolume' : 'TradingShares'), value: n(tw ? 'TradeValue' : 'TransactionAmount'),
      pe: parseNumber(ratio[tw ? 'PEratio' : 'PriceEarningRatio']), yield: parseNumber(ratio[tw ? 'DividendYield' : 'YieldRatio']), pb: parseNumber(ratio[tw ? 'PBratio' : 'PriceBookRatio']),
    }];
  });
}
export function parseDividends(data: unknown, market: Market): DividendEvent[] {
  const tw = market === '上市';
  return stockRows(data).flatMap(r => {
    const date = parseRocDate(r[tw ? 'Date' : 'ExRrightsExDividendDate'] ?? '');
    const type = (r[tw ? 'Exdividend' : 'ExRrightsExDividend'] ?? '').trim().replace(/^除/, '');
    if (!date || !['息', '權', '權息'].includes(type)) return [];
    const positive = (key: string) => { const n = parseNumber(r[key]); return n !== null && n > 0 ? n : null; };
    const subscription = (key: string) => r[key]?.trim() === '尚未公告' ? '尚未公告' as const : positive(key);
    return [{ market, code: r[tw ? 'Code' : 'SecuritiesCompanyCode'], name: r[tw ? 'Name' : 'CompanyName'], date,
      type: `除${type}` as DividendEvent['type'], cash: parseNumber(r.CashDividend), stockRatio: positive('StockDividendRatio'),
      subscriptionRatio: subscription(tw ? 'SubscriptionRatio' : 'SubscriptionRatioToNewSharesIssued'), subscriptionPrice: subscription('SubscriptionPricePerShare'),
    }];
  });
}
