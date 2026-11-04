import type { StockDate } from './parse.js';

export interface MarketMargin {
  date: StockDate; dateConfirmed: boolean; reason?: string;
  financePrev: number; finance: number; shortPrev: number; short: number;
}
export interface MarketBlock {
  dataDate: StockDate; taiex: number; change: number; value: number;
  margin?: MarketMargin;
  // Describes the current feed even when margin retains an older confirmed day.
  marginReason?: string;
}
export interface MarketSummary { twse?: MarketBlock; tpex?: MarketBlock; fetchedAt: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isDate(value: unknown): value is StockDate {
  if (!isRecord(value)) return false;
  const { year, month, day } = value;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number'
    || ![year, month, day].every(Number.isInteger) || year <= 1911) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
function isMargin(value: unknown): value is MarketMargin {
  return isRecord(value) && isDate(value.date) && typeof value.dateConfirmed === 'boolean'
    && optionalString(value.reason)
    && [value.financePrev, value.finance, value.shortPrev, value.short].every(n => isNumber(n) && Number.isSafeInteger(n) && n >= 0);
}
export function isMarketBlock(value: unknown): value is MarketBlock {
  return isRecord(value) && isDate(value.dataDate)
    && isNumber(value.taiex) && value.taiex > 0
    && isNumber(value.change) && value.taiex - value.change > 0
    && isNumber(value.value) && value.value >= 0
    && (value.margin === undefined || isMargin(value.margin)) && optionalString(value.marginReason);
}
/** Invalid markets are absent independently; collection metadata never hides a valid market. */
export function decodeMarketSummary(value: unknown): MarketSummary {
  const data = isRecord(value) ? value : {};
  return {
    ...(isMarketBlock(data.twse) ? { twse: data.twse } : {}),
    ...(isMarketBlock(data.tpex) ? { tpex: data.tpex } : {}),
    fetchedAt: typeof data.fetchedAt === 'string' ? data.fetchedAt : '',
  };
}
