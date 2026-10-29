import { taipeiParts, type Clock } from '../clock.js';
import { rocDateLabel, type DividendEvent, type StockDate, type StockQuote } from './parse.js';
import type { StockIdentity, StockLookup } from './lookup.js';
const number = (n: number | null, digits = 2) => n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const decimal = (n: number, digits = 20) => Number.isFinite(n) ? Number(n.toFixed(digits)).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: digits }) : '—';
const signed = (n: number) => `${n > 0 ? '+' : ''}${number(n)}`;
export const stockFooter = '資料來源：臺灣證券交易所、證券櫃檯買賣中心 OpenAPI；以公司公告為準。';
export const dateKey = (d: StockDate) => d.year * 10000 + d.month * 100 + d.day;
export function formatStockLookup(query: string, result: Exclude<StockLookup<StockIdentity>, { kind: 'one' }>): string {
  if (result.kind === 'none') return `找不到「${query}」，請輸入股票代號（例如 2330）或名稱（例如 台積電）。`;
  return [`找到 ${result.stocks.length} 檔符合「${query}」的股票，請指定代號：`, ...result.stocks.slice(0, 10).map(s => `- ${s.code} ${s.name}（${s.market}）`), ...(result.stocks.length > 10 ? [`…另有 ${result.stocks.length - 10} 檔`] : [])].join('\n');
}
export function quoteStalenessNote(s: StockQuote, clock: Clock, checkedAt?: string): string {
  const now = clock(), today = taipeiParts(now);
  const end = Date.UTC(today.year, today.month - 1, today.day);
  let weekdays = 0;
  for (let day = Date.UTC(s.date.year, s.date.month - 1, s.date.day) + 86400000; day < end; day += 86400000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && ++weekdays >= 3) {
      const checked = checkedAt ? new Date(checkedAt) : null, age = checked ? now.getTime() - checked.getTime() : NaN;
      if (s.market === '上櫃' && age >= 0 && age <= 72 * 3600000) return `（注意：上櫃資料停在 ${rocDateLabel(s.date)}；${rocDateLabel(taipeiParts(checked!))} 已確認櫃買中心尚無更新資料，可能為休市）`;
      return `（注意：${s.market}資料停在 ${rocDateLabel(s.date)}，可能尚未更新）`;
    }
  }
  return '';
}
export function formatStockQuote(s: StockQuote, clock?: Clock, checkedAt?: string): string {
  const note = clock ? quoteStalenessNote(s, clock, checkedAt) : '';
  const pct = s.close !== null && s.change !== null && s.close - s.change > 0 ? `（${signed(s.change / (s.close - s.change) * 100)}%）` : '';
  const amount = s.value === null ? '—' : s.value >= 1e8 ? `${number(s.value / 1e8)} 億元` : `${number(s.value / 1e4, 0)} 萬元`;
  return [`${s.name}（${s.code}）｜${s.market}`, `資料日期：${rocDateLabel(s.date)}（盤後資料，非即時）`,
    ...(s.close === null ? ['當日無成交'] : [
      `收盤 ${number(s.close)}｜漲跌 ${s.changeNote ? `${s.changeNote}（不計漲跌）` : s.change === null ? '—' : signed(s.change) + pct}`,
      `開盤 ${number(s.open)}｜最高 ${number(s.high)}｜最低 ${number(s.low)}`,
    ]),
    `成交量 ${number(s.volumeShares === null ? null : Math.round(s.volumeShares / 1000), 0)} 張（${s.market === '上市' ? '含零股' : '不含零股'}）｜成交金額 ${amount}`,
    `本益比 ${number(s.pe)}｜殖利率 ${number(s.yield)}${s.yield === null ? '' : '%'}｜股價淨值比 ${number(s.pb)}${s.ratioDate && [s.pe, s.yield, s.pb].some(n => n !== null) ? `（本益比資料日期 ${rocDateLabel(s.ratioDate)}）` : ''}`,
    `資料來源：${s.market === '上市' ? '臺灣證券交易所' : '證券櫃檯買賣中心'} OpenAPI`,
    ...(note ? [note] : []),
  ].join('\n');
}
export function formatStockDividends(events: DividendEvent[], clock: Clock, stock?: StockIdentity, limit = 20, markets = '上市＋上櫃'): string {
  const today = taipeiParts(clock());
  const upcoming = events.filter(e => dateKey(e.date) >= dateKey(today) && (!stock || e.code === stock.code && e.market === stock.market)).sort((a, b) => dateKey(a.date) - dateKey(b.date) || a.code.localeCompare(b.code));
  const title = stock ? `${stock.name}（${stock.code}）${upcoming.length ? '近期除權息' : '目前沒有已公告的近期除權息。'}` : `近期除權息（${rocDateLabel(today)}起，${markets}，依日期排序，列出前 ${Math.min(limit, upcoming.length)} 筆／共 ${upcoming.length} 筆）`;
  const lines = upcoming.slice(0, limit).map(e => {
    const details: string[] = [];
    if (e.type.includes('息')) details.push(e.cash === null ? '現金股利尚未公告' : `現金股利 ${decimal(e.cash, 4)} 元`);
    if (e.stockRatio !== null) details.push(`每千股配 ${decimal(e.stockRatio * 1000, 2)} 股`);
    if (e.subscriptionRatio !== null) details.push(e.subscriptionRatio === '尚未公告' ? '現金增資認購率尚未公告' : `每千股可認購 ${decimal(e.subscriptionRatio * 1000, 2)} 股`);
    if (e.subscriptionPrice !== null) details.push(e.subscriptionPrice === '尚未公告' ? '認購價尚未公告' : `認購價 ${decimal(e.subscriptionPrice)} 元`);
    const weekday = '日一二三四五六'[new Date(Date.UTC(e.date.year, e.date.month - 1, e.date.day)).getUTCDay()];
    return `- ${rocDateLabel(e.date)}（${weekday}）${e.name}（${e.code}）${e.market}｜${e.type}${details.length ? `｜${details.join('、')}` : ''}`;
  });
  return [title, ...lines, stockFooter].join('\n');
}
