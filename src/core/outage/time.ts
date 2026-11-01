import { norm } from '../garbage/text.js';
import type { Times } from './model.js';
export const local = (date: Date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function validDay(s: string): boolean { return /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s; }
export function parseDate(text: string): string | null {
  const s = norm(text);
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(s)) { const d = new Date(s); return validDay(s.slice(0, 10)) && Number.isFinite(d.getTime()) ? local(d) : null; }
  const m = /^(\d{2,4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const year = +m[1] + (m[1].length < 4 ? 1911 : 0), day = `${year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (!validDay(day) || +(m[4] ?? 0) > 23 || +(m[5] ?? 0) > 59 || +(m[6] ?? 0) > 59) return null;
  return `${day}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}`;
}
export function waterTimes(start: string, end: string): Times {
  const a = parseDate(start), b = parseDate(end);
  return a && b && a <= b ? [[a, b]] : `${start || '未標示開始時間'}～${end || '未標示恢復時間'}`;
}
export function powerWindow(raw: string): [string, string] | null {
  const [start, end, extra] = norm(raw).split(/[~～]/); if (!end || extra !== undefined) return null;
  const a = parseDate(start.trim()); if (!a) return null;
  let b = parseDate(/^\d{1,2}:\d\d$/.test(end.trim()) ? `${a.slice(0, 10)} ${end.trim()}` : end.trim());
  if (!b) return null;
  if (b < a && /^\d{1,2}:\d\d$/.test(end.trim())) b = `${addDays(b.slice(0, 10), 1)}${b.slice(10)}`;
  return b >= a ? [a, b] : null;
}
export function dailyTimes(date: string, time: string): Times {
  const days = norm(date).split(/[~～]/), a = parseDate(days[0]), b = parseDate(days[1] ?? days[0]);
  const raw = `${date} ${time}`.trim() || '未標示時間';
  if (days.length > 2 || !a || !b || b < a || (Date.parse(b) - Date.parse(a)) / 86400000 > 366 || !/^\d{1,2}:\d\d\s*[~～]\s*\d{1,2}:\d\d$/.test(norm(time))) return raw;
  const ranges: [string, string][] = [];
  for (let day = a.slice(0, 10); day <= b.slice(0, 10); day = addDays(day, 1)) { const t = powerWindow(`${day} ${time}`); if (!t) return raw; ranges.push(t); }
  return ranges;
}
export function formatTimes(t: Times): string {
  if (typeof t === 'string') return `${t}（官方時間原文）`;
  const date = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}（${'日一二三四五六'[new Date(`${s.slice(0, 10)}T00:00:00Z`).getUTCDay()]}）`;
  const windows = [...t].sort(([a], [b]) => a.localeCompare(b)), parts: string[] = [];
  for (let i = 0; i < windows.length; i++) {
    const [a, b] = windows[i]; let last = i;
    if (b.slice(0, 10) <= addDays(a.slice(0, 10), 1)) while (last + 1 < windows.length) {
      const [nextA, nextB] = windows[last + 1];
      if (nextA.slice(0, 10) !== addDays(windows[last][0].slice(0, 10), 1) || nextB.slice(0, 10) !== addDays(windows[last][1].slice(0, 10), 1) || nextA.slice(11) !== a.slice(11) || nextB.slice(11) !== b.slice(11)) break;
      last++;
    }
    parts.push(last > i ? `${date(a)}～${date(windows[last][0])}每日 ${a.slice(11)}–${a.slice(0, 10) === b.slice(0, 10) ? '' : '翌日 '}${b.slice(11)}` : `${date(a)}${a.slice(11)}–${a.slice(0, 10) === b.slice(0, 10) ? '' : date(b)}${b.slice(11)}`); i = last;
  }
  return parts.join('；');
}
