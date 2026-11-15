import { comparePeriods, expectedDrawDate, latestExpectedDrawnPeriod, periodLabel, type Draw } from './invoice/parse.js';
import { updated } from './rail/time.js';

const hour = 3_600_000;
// Worker TWSE cron: UTC weekdays every 30m → 30m × 2 + 15m buffer = 75m.
export const TWSE_WEEKDAY_STALE_MS = 75 * 60_000;
// UTC weekends every 6h → 6h × 2 + 1h buffer = 13h (also covers Monday's transition).
export const TWSE_WEEKEND_STALE_MS = 13 * hour;
// tpex-collect runs :17/:47 UTC 06–10 weekdays. In-window interval is 30m,
// but Fri 10:47 → Mon 06:17 is 67.5h: longest interval × 2 + 1h = 136h.
// Use wall time including closed windows, so normal nights/weekends never warn.
export const TPEX_DIVIDENDS_STALE_MS = 136 * hour;
// rail-snapshot runs at UTC 16:23/20:23 (4h/20h gaps, not evenly spaced 12h).
// Max interval 20h × 2 + 8h buffer = 48h: tomorrow's immutable timetable can
// be fetched just after Taipei midnight yesterday and served until tonight.
export const RAIL_TIMETABLE_STALE_MS = 48 * hour;
// publish-rail refreshes stations only after 7d; the next cron can be 20h later.
// Effective interval (7d + 20h) × 2 + 4h scheduling buffer = 380h.
export const RAIL_STATIONS_STALE_MS = 380 * hour;
// Odd-month 25th draws: allow 3 full days for publication delays/corrections.
// Reuse the invoice calendar, not snapshot age. The 3h cron (plus 10m draw-day
// polls) does not make an unchanged, valid two-month draw stale. Deliberately
// do not warn on fetch age alone, and therefore need no invoice heartbeat.
export const INVOICE_DRAW_BUFFER_MS = 3 * 24 * hour;

export function isStale(at: string | undefined, now: Date, threshold: number): boolean {
  return !at || !Number.isFinite(Date.parse(at)) || now.getTime() - Date.parse(at) > threshold;
}
export function twseDividendsThreshold(at: string | undefined, now: Date): number {
  const weekend = (date: Date) => [0, 6].includes(date.getUTCDay());
  return weekend(now) || (at !== undefined && weekend(new Date(at))) ? TWSE_WEEKEND_STALE_MS : TWSE_WEEKDAY_STALE_MS;
}
export function staleWarning(at: string | undefined, detail?: string): string {
  return `⚠️ 資料可能不是最新（最後更新：${updated(at)}${detail ? `；${detail}` : ''}）`;
}
export function railWarnings(timetables: { fetchedAt: string }[], stations: { fetchedAt: string } | null, now: Date): string[] {
  return [...new Set(timetables.filter(s => isStale(s.fetchedAt, now, RAIL_TIMETABLE_STALE_MS)).map(s => staleWarning(s.fetchedAt, '表訂時刻表'))),
    ...(stations && isStale(stations.fetchedAt, now, RAIL_STATIONS_STALE_MS) ? [staleWarning(stations.fetchedAt, '車站資料')] : [])];
}
export function invoiceWarning(draws: Draw[], updatedAt: string, now: Date): string {
  if (!draws.length) return '';
  // During a new draw's grace period the preceding draw is still required;
  // an already overdue snapshot must not become "fresh" again every draw day.
  const expected = latestExpectedDrawnPeriod(() => new Date(now.getTime() - INVOICE_DRAW_BUFFER_MS - 1)), draw = expectedDrawDate(expected);
  const deadline = Date.parse(`${draw.year}-${String(draw.month).padStart(2, '0')}-${draw.day}T00:00:00+08:00`) + INVOICE_DRAW_BUFFER_MS;
  const latest = draws.reduce((a, b) => comparePeriods(a.period, b.period) >= 0 ? a : b);
  return now.getTime() > deadline && !draws.some(d => comparePeriods(d.period, expected) >= 0)
    ? staleWarning(updatedAt, `快照最新期別為 ${periodLabel(latest.period)}；${periodLabel(expected)}新一期開獎資料可能尚未收錄`) : '';
}
