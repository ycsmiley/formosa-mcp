import { taipeiParts, type Clock } from '../clock.js';
export type Period = { rocYear: number; evenMonth: number };
export type Draw = { period: Period; special: string; grand: string; first: string[]; extraSixth: string[]; pubDate?: string; sourceUrl?: string };
const pad = (n: number) => String(n).padStart(2, '0');
export const periodCode = (p: Period) => `${p.rocYear}${pad(p.evenMonth)}`;
export const periodLabel = (p: Period) => `${p.rocYear}年${pad(p.evenMonth - 1)}-${pad(p.evenMonth)}月`;
export function normalizePeriod(input: string): Period | null {
  const trimmed = input.trim();
  const s = /^\d{5}$/.test(trimmed) ? `${trimmed.slice(0, 3)}-${trimmed.slice(3)}` : trimmed;
  const m = /^(\d{3,4})(?:年\s*|[-/])?(\d{1,2})(?:\s*[-~～]\s*(\d{1,2}))?月?$/.exec(s);
  if (!m) return null;
  let year = +m[1];
  if (m[1].length === 4) { if (year < 1912) return null; year -= 1911; }
  const month = +m[2], end = m[3] ? +m[3] : undefined;
  if (year < 1 || month < 1 || month > 12 || (end !== undefined && (month % 2 !== 1 || end !== month + 1))) return null;
  return { rocYear: year, evenMonth: month + month % 2 };
}
export const comparePeriods = (a: Period, b: Period) => a.rocYear - b.rocYear || a.evenMonth - b.evenMonth;
export const previousPeriod = (p: Period): Period => p.evenMonth === 2 ? { rocYear: p.rocYear - 1, evenMonth: 12 } : { ...p, evenMonth: p.evenMonth - 2 };
export function parseInvoiceFeed(xml: string): Draw[] {
  const draws: Draw[] = [];
  for (const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(item[1])?.[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
    const period = normalizePeriod(tag('title') ?? '');
    const description = tag('description') ?? '';
    const numbers = (name: string, length: number) => {
      const text = new RegExp(`<p>\\s*${name}\\s*[：:]([^<]*)<\\/p>`).exec(description)?.[1] ?? '';
      const values = text.split('、').map(s => s.trim());
      return values.every(s => new RegExp(`^\\d{${length}}$`).test(s)) ? values : [];
    };
    const special = numbers('特別獎', 8), grand = numbers('特獎', 8), first = numbers('頭獎', 8);
    if (!period || special.length !== 1 || grand.length !== 1 || first.length !== 3) continue;
    draws.push({ period, special: special[0], grand: grand[0], first, extraSixth: numbers('增開六獎', 3), pubDate: tag('pubDate'), sourceUrl: tag('link') });
  }
  if (!draws.length) throw new Error('財政部資料中沒有可解析的開獎期別');
  return draws.sort((a, b) => comparePeriods(b.period, a.period));
}
export function expectedDrawDate(p: Period) {
  return { year: p.rocYear + 1911 + (p.evenMonth === 12 ? 1 : 0), month: p.evenMonth === 12 ? 1 : p.evenMonth + 1, day: 25 as const };
}
export function claimPeriod(p: Period) {
  const draw = expectedDrawDate(p);
  const date = (offset: number, day: number) => {
    const d = new Date(Date.UTC(draw.year, draw.month - 1 + offset, day));
    return { year: d.getUTCFullYear() - 1911, month: d.getUTCMonth() + 1, day };
  };
  return { start: date(1, 6), end: date(4, 5) };
}
export function isClaimable(p: Period, clock: Clock) {
  const now = taipeiParts(clock());
  const { start, end } = claimPeriod(p);
  const key = (d: { year: number; month: number; day: number }) => d.year * 10000 + d.month * 100 + d.day;
  const today = key({ ...now, year: now.year - 1911 });
  return today >= key(start) && today <= key(end);
}
export function latestExpectedDrawnPeriod(clock: Clock): Period {
  const { year, month, day } = taipeiParts(clock());
  const announcementMonth = month % 2 ? month - (day < 25 ? 2 : 0) : month - 1;
  const date = new Date(Date.UTC(year, announcementMonth - 2, 1));
  return { rocYear: date.getUTCFullYear() - 1911, evenMonth: date.getUTCMonth() + 1 };
}
