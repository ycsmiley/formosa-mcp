import { taipeiParts, type Clock } from '../clock.js';
import { dateKey, stockFooter } from './format.js';
import { parseNumber, parseRocDate, rocDateLabel, stockRows, type StockDate } from './parse.js';
import { marketUrls } from './source.js';

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
export interface MarketInputs {
  fmtqik: unknown; margn: unknown; fmtqikLastModified?: string; margnLastModified?: string;
  tpexIndex: unknown; tpexMargin: unknown;
  // Supplied by the caller so parsing stays deterministic and independent of the clock.
  fetchedAt?: string;
}
function rows(body: unknown, minimum = 1) {
  const result = stockRows(body);
  if (result.length < minimum) throw new Error(`大盤資料筆數不足：${result.length} < ${minimum}`);
  return result;
}
function numeric(row: Record<string, string>, key: string, blankZero = false) {
  const value = blankZero && row[key]?.trim() === '' ? 0 : parseNumber(row[key]);
  if (value === null || blankZero && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`大盤資料欄位不正確：${key}`);
  return value;
}
function date(row: Record<string, string>) {
  const result = parseRocDate(row.Date ?? '');
  if (!result) throw new Error('大盤資料日期不正確');
  return result;
}
function index(body: unknown, twse: boolean): MarketBlock {
  const data = rows(body);
  const latest = data.reduce((a, b) => dateKey(date(a)) >= dateKey(date(b)) ? a : b);
  const block = { dataDate: date(latest), taiex: numeric(latest, twse ? 'TAIEX' : 'TPExIndex'), change: numeric(latest, 'Change'), value: numeric(latest, twse ? 'TradeValue' : 'TradeAmount') };
  for (const row of data) {
    date(row);
    for (const key of twse ? ['TAIEX', 'Change', 'TradeValue', 'TradeVolume', 'Transaction'] : ['TPExIndex', 'Change', 'TradeAmount', 'TradeVolume', 'NumberOfTransactions']) numeric(row, key);
  }
  if (block.taiex <= 0 || block.taiex - block.change <= 0 || block.value < 0) throw new Error('大盤指數或成交金額不正確');
  return block;
}
function margin(body: unknown, twse: boolean, dataDate: StockDate): MarketMargin {
  const data = rows(body, twse ? 100 : 50);
  const fields = twse ? ['融資前日餘額', '融資今日餘額', '融券前日餘額', '融券今日餘額'] : ['MarginPurchaseBalancePreviousDay', 'MarginPurchaseBalance', 'ShortSaleBalancePreviousDay', 'ShortSaleBalance'];
  const totals = fields.map(key => data.reduce((sum, row) => sum + numeric(row, key, true), 0));
  if (!twse) for (const row of data) date(row);
  return { date: dataDate, dateConfirmed: true, financePrev: totals[0], finance: totals[1], shortPrev: totals[2], short: totals[3] };
}
function twseMarginReason(dataDate: StockDate, fmtqik?: string, margn?: string): string | undefined {
  const a = fmtqik ? Date.parse(fmtqik) : NaN, b = margn ? Date.parse(margn) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'FMTQIK 或 MI_MARGN 缺少可解析的 Last-Modified 標頭。';
  const close = Date.UTC(dataDate.year, dataDate.month - 1, dataDate.day, 6, 30);
  if (a < close || b < close) return 'FMTQIK 或 MI_MARGN 的 Last-Modified 早於指數資料日台北時間 14:30。';
  if (Math.abs(b - a) > 6 * 3600000) return b < a ? 'MI_MARGN 的 Last-Modified 比 FMTQIK 舊超過 6 小時。' : 'MI_MARGN 的 Last-Modified 比 FMTQIK 新超過 6 小時。';
}
/** Body validation is independent per market; a failed market retains its previous block. */
export function buildMarketSummary(input: MarketInputs, previous?: MarketSummary): MarketSummary {
  const errors: string[] = [];
  const build = (twse: boolean): MarketBlock | undefined => {
    const old = twse ? previous?.twse : previous?.tpex;
    try {
      const block = index(twse ? input.fmtqik : input.tpexIndex, twse);
      const body = twse ? input.margn : input.tpexMargin;
      const totals = margin(body, twse, block.dataDate);
      const reason = twse ? twseMarginReason(block.dataDate, input.fmtqikLastModified, input.margnLastModified)
        : rows(body).some(row => dateKey(date(row)) !== dateKey(block.dataDate)) ? '上櫃融資券各筆日期未全部等於上櫃指數資料日期。' : undefined;
      if (reason) {
        block.marginReason = reason;
        if (old?.margin?.dateConfirmed) block.margin = old.margin;
      } else block.margin = totals;
      return block;
    } catch (error) {
      errors.push(`${twse ? '上市' : '上櫃'}：${error instanceof Error ? error.message : String(error)}`);
      return old;
    }
  };
  const twse = build(true), tpex = build(false);
  if (!twse && !tpex) throw new Error(errors.join('；'));
  return { ...(twse ? { twse } : {}), ...(tpex ? { tpex } : {}), fetchedAt: input.fetchedAt ?? previous?.fetchedAt ?? '' };
}
const number = (n: number, digits = 2) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${number(n, digits)}`;
function staleness(block: MarketBlock, market: string, now: Date) {
  const today = taipeiParts(now);
  let expected = Date.UTC(today.year, today.month - 1, today.day);
  // Weekday-only expectation, deliberately retaining dated data across holidays/typhoons.
  if (today.hour < 14 || today.hour === 14 && now.getUTCMinutes() < 30) expected -= 86400000;
  while ([0, 6].includes(new Date(expected).getUTCDay())) expected -= 86400000;
  let weekdays = 0;
  for (let day = Date.UTC(block.dataDate.year, block.dataDate.month - 1, block.dataDate.day) + 86400000; day <= expected; day += 86400000) {
    if (![0, 6].includes(new Date(day).getUTCDay()) && ++weekdays > 1) return `（注意：${market}資料停在 ${rocDateLabel(block.dataDate)}，可能尚未更新或遇休市）`;
  }
  return '';
}
export function formatMarketSummary(summary: MarketSummary, clock: Clock): string {
  const now = clock(), today = taipeiParts(now), minutes = today.hour * 60 + now.getUTCMinutes();
  const trading = ![0, 6].includes(new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay()) && minutes >= 540 && minutes <= 810;
  const lines: string[] = [];
  for (const key of ['twse', 'tpex'] as const) {
    const block = summary[key], twse = key === 'twse', market = twse ? '上市' : '上櫃';
    lines.push(market);
    if (!block) lines.push('資料暫時無法取得。');
    else {
      lines.push(`資料日期：${rocDateLabel(block.dataDate)}（盤後資料，非即時）`,
        `${twse ? '加權指數' : '上櫃指數'} 收盤 ${number(block.taiex)}｜漲跌 ${signed(block.change)} 點（${signed(block.change / (block.taiex - block.change) * 100)}%）`,
        `成交金額 ${number(block.value / 1e8)} 億元`);
      const reason = block.marginReason ?? (block.margin?.dateConfirmed === false ? block.margin.reason : undefined);
      if (reason) lines.push(`融資券無法確認資料日期：${reason}`);
      if (block.margin?.dateConfirmed) {
        const m = block.margin;
        lines.push(`${reason ? '上次確認的融資券資料日期' : '融資券資料日期'}：${rocDateLabel(m.date)}`,
          `融資餘額 ${number(m.finance, 0)} 張（較前日 ${signed(m.finance - m.financePrev, 0)} 張）`,
          `融券餘額 ${number(m.short, 0)} 張（較前日 ${signed(m.short - m.shortPrev, 0)} 張）`);
      } else lines.push('融資券暫不提供。');
      const note = staleness(block, market, now);
      if (note) lines.push(note);
    }
    lines.push(`資料來源：${twse ? '臺灣證券交易所 FMTQIK' : '證券櫃檯買賣中心 tpex_daily_trading_index'} ${twse ? marketUrls.fmtqik : marketUrls.tpexIndex}`,
      `融資券來源：${twse ? '臺灣證券交易所 MI_MARGN' : '證券櫃檯買賣中心 tpex_mainboard_margin_balance'} ${twse ? marketUrls.margn : marketUrls.tpexMargin}`);
  }
  if (trading) lines.push('這是前一個交易日收盤資料，不是即時行情');
  return [...lines, stockFooter, '股票資料為盤後資料，僅供參考，不構成投資建議。'].join('\n');
}
