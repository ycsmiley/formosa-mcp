import { RailError } from './client.js';

const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const taipeiFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function taipeiNow(date: Date) {
  const parts = Object.fromEntries(taipeiFormatter.formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}
export function parseDate(input: string | undefined, now: Date): string {
  const value = input?.trim();
  const today = taipeiNow(now).date;
  if (value === undefined) return today;
  const offset = ['今天', '明天', '後天'].indexOf(value);
  if (offset >= 0) return dateText(new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400_000));
  const match = /^(?:民國\s*)?(\d{3}|\d{4})([-/])(\d{2})\2(\d{2})$/.exec(value);
  const invalid = () => new RailError('日期格式不正確，請輸入 YYYY-MM-DD、YYYY/MM/DD、民國 115-10-28、今天、明天或後天');
  if (!match || (value.startsWith('民國') && match[1].length !== 3)) throw invalid();
  const year = +match[1] + (match[1].length === 3 ? 1911 : 0), month = +match[3], day = +match[4];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1912 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw invalid();
  return dateText(date);
}
export function minutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m || +m[1] > 23 || +m[2] > 59 || (m[3] && +m[3] > 59)) return undefined;
  return +m[1] * 60 + +m[2];
}
export function parseTime(value: string | undefined, date: string, now: Date) {
  if (value === undefined) { const local = taipeiNow(now); return date === local.date ? local.minutes : 0; }
  const parsed = /^\d{2}:\d{2}$/.test(value) ? minutes(value) : undefined;
  if (parsed === undefined) throw new RailError('時間格式不正確，請輸入 HH:mm（00:00～23:59）');
  return parsed;
}
export function hhmm(value: number) { const m = value % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
export function updated(value: unknown): string {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return '更新時間未提供';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '更新時間未提供';
  const local = taipeiNow(date);
  return `${local.date} ${hhmm(local.minutes)}（臺北時間）`;
}

/** Operating-day offsets. OD responses lack the full route; mark clock-based inference. */
export function operatingTimes(departure: number, arrival: number, overnight: boolean, crossing: 'origin' | 'destination' | undefined) {
  let dep = departure, arr = arrival, inferred = false;
  if (crossing === 'origin') { dep += 1440; arr += 1440; }
  else if (crossing === 'destination') arr += 1440;
  else if (arrival < departure) arr += 1440;
  else if (overnight) {
    // Early-morning stops of an overnight service follow that operating day's evening.
    // Noon is an explicit fallback, not an assertion about undocumented TDX semantics.
    if (departure < 720) { dep += 1440; arr += 1440; }
    else arr += 1440;
    inferred = true;
  }
  if (arr < dep) arr += 1440;
  return { departure: dep, arrival: arr, inferred };
}
