import { data } from './data.js';
export const coveredYears = Object.keys(data).map(Number);
type YearData = { days: string; notes: Readonly<Record<string, string>>; entries: readonly (readonly [string, string, boolean])[]; source: { title: string; url: string; published: string; twse: string; fetched: string } };
export function calendarDay(date: string) {
  return interpretDay(date, (data as Record<number, YearData>)[Number(date.slice(0, 4))]);
}
export function interpretDay(date: string, record?: YearData) {
  const year = Number(date.slice(0, 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !record) return { date, covered: false as const };
  const day = new Date(date), weekday = day.getUTCDay(), weekend = weekday === 0 || weekday === 6;
  const index = (day.getTime() - Date.UTC(year, 0, 1)) / 86400000, note = record.notes[date];
  const office: 'holiday' | 'weekend' | 'makeup_workday' | 'workday' = record.days[index] === '0' ? weekend ? 'makeup_workday' : 'workday' : weekend && !note ? 'weekend' : 'holiday';
  const entry = record.entries.find(e => e[0] === date);
  return { date, weekday, covered: true as const, office, ...(note ? { note } : {}), market: { open: !weekend && (!entry || entry[2]), ...(entry ? { name: entry[1] } : {}) }, sources: record.source };
}
export function isTradingDay(date: string): boolean | undefined { const day = calendarDay(date); return day.covered ? day.market.open : undefined; }
