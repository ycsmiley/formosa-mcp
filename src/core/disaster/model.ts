import { counties } from '../outage/districts.js';
import { clean } from '../outage/normalize.js';
import { validDay } from '../outage/time.js';
export const sources = ['dgpa', 'ncdr'] as const;
export type Source = typeof sources[number];
export type Writer = 'worker' | 'gha';
export interface State { ok: boolean; reason?: string; closed?: boolean; skipped?: boolean; fetchedAt?: string; lastSuccessAt?: string; sourceUpdatedAt?: string; sha?: string; count?: number; writtenAt?: string; empty?: boolean }
export interface Index { v: 1; writer: Writer; heartbeatAt: string; budget?: { tokens: number; at: string }; sources: Partial<Record<Source, State>> }
export interface Dgpa { pageDate: string; layout: 'none' | 'regional' | 'flat'; noEvent: boolean; counties: Record<string, string[]> }
export const severities = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const;
export interface Alert { id: string; type: string; title?: string; sender?: string; severity?: typeof severities[number]; level?: string; color?: string; effective?: string; expires?: string; counties: string[]; areas?: string[]; areaCounties?: string[][]; text: string; link: string; detail: boolean; complete?: boolean }
export const indexKey = (writer: Writer) => `disaster:index:${writer}:v1`;
export const shardKey = (source: Source, sha: string) => `disaster:v1:${source}:${sha.slice(0, 12)}`;
export const official = { dgpa: 'https://www.dgpa.gov.tw/typh/daily/nds.html', ncdr: 'https://alerts.ncdr.nat.gov.tw/' };
export const feedUrls = ['https://alerts.ncdr.nat.gov.tw/JSONAtomFeeds.ashx', 'https://alerts.ncdr.nat.gov.tw/RssAtomFeeds.ashx'] as const;
export const safeLink = (s: string): string => {
  try { const u = new URL(s); if (s.length <= 300 && clean(s) === s && u.protocol === 'https:' && u.hostname === 'alerts.ncdr.nat.gov.tw' && !u.port && !u.username && !u.password && !/^https:\/\/[^/]*:/i.test(s)) return s; } catch { /* Use official lookup. */ }
  return official.ncdr;
};
export const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
export const timestamp = (x: unknown): boolean => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) && validDay(x.slice(0, 10)) && Number.isFinite(Date.parse(x)) && +x.slice(11, 13) < 24 && +x.slice(14, 16) < 60 && +x.slice(17, 19) < 60;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string' && v.length > 0);
export function decodeIndex(raw: string): Index {
  const x: unknown = JSON.parse(raw);
  if (!object(x) || x.v !== 1 || !['worker', 'gha'].includes(x.writer) || !timestamp(x.heartbeatAt) || !object(x.sources)) throw Error('災防索引格式錯誤');
  if (x.budget !== undefined && (!object(x.budget) || typeof x.budget.tokens !== 'number' || !Number.isFinite(x.budget.tokens) || x.budget.tokens < -1 || !timestamp(x.budget.at))) throw Error('災防預算格式錯誤');
  for (const [s, v] of Object.entries(x.sources)) {
    if (!sources.includes(s as Source) || !object(v) || typeof v.ok !== 'boolean' || ['closed', 'skipped', 'empty'].some(k => v[k] !== undefined && typeof v[k] !== 'boolean') || (v.reason !== undefined && (typeof v.reason !== 'string' || v.reason.length > 200)) || ['fetchedAt', 'lastSuccessAt', 'sourceUpdatedAt', 'writtenAt'].some(k => v[k] !== undefined && !timestamp(v[k])) || (v.sha !== undefined && (typeof v.sha !== 'string' || !/^[a-f0-9]{12}$/.test(v.sha))) || (v.count !== undefined && (!Number.isSafeInteger(v.count) || v.count < 0)) || (v.empty !== undefined && v.count !== 0) || (v.closed && v.ok) || (v.sha !== undefined && (!v.lastSuccessAt || !v.sourceUpdatedAt || !v.writtenAt || v.count === undefined)) || (v.ok && !v.sha && !v.skipped)) throw Error('災防來源格式錯誤');
  }
  return x as unknown as Index;
}
export function decodeDgpa(raw: string): Dgpa {
  const x: unknown = JSON.parse(raw);
  if (!object(x) || !validDay(x.pageDate) || !['none', 'regional', 'flat'].includes(x.layout) || typeof x.noEvent !== 'boolean' || !object(x.counties) || Object.entries(x.counties).some(([c, lines]) => !counties.includes(c) || !strings(lines) || !lines.length || lines.length > 20 || lines.some(l => l.length > 300 || clean(l) !== l)) || (x.noEvent ? x.layout !== 'none' || Object.keys(x.counties).length !== 0 : x.layout === 'none' || !Object.keys(x.counties).length)) throw Error('停班停課快照格式錯誤');
  return x as unknown as Dgpa;
}
export function decodeAlerts(raw: string): Alert[] {
  const x: unknown = JSON.parse(raw);
  if (!Array.isArray(x)) throw Error('告警快照格式錯誤');
  const ids = new Set<string>();
  for (const v of x) {
    if (!object(v) || !['id', 'type', 'text', 'link'].every(k => typeof v[k] === 'string') || !v.id || !v.type || ids.has(v.id) || typeof v.detail !== 'boolean' || (v.complete !== undefined && typeof v.complete !== 'boolean') || (v.complete === true && (!v.detail || !v.counties?.length)) || !strings(v.counties) || v.counties.some((c: string) => !counties.includes(c)) || new Set(v.counties).size !== v.counties.length || Object.entries({ type: 40, title: 200, sender: 100, level: 60, color: 20, text: 400 }).some(([k, limit]) => v[k] !== undefined && (typeof v[k] !== 'string' || v[k].length > limit || clean(v[k]) !== v[k])) || v.text.length > 400 || (v.severity !== undefined && !severities.includes(v.severity)) || ['effective', 'expires'].some(k => v[k] !== undefined && !timestamp(v[k])) || (v.areas !== undefined && (!strings(v.areas) || v.areas.length > 200 || v.areas.some((a: string) => a.length > 100 || clean(a) !== a))) || v.link.length > 300) throw Error('告警項目格式錯誤');
    if (v.areaCounties !== undefined && (!Array.isArray(v.areaCounties) || !Array.isArray(v.areas) || v.areaCounties.length !== v.areas.length || v.areaCounties.some((cs: unknown) => !strings(cs) || !cs.length || cs.some(c => !v.counties.includes(c)) || new Set(cs).size !== cs.length))) throw Error('告警區域縣市格式錯誤');
    ids.add(v.id);
  }
  return x as Alert[];
}
export function decodeShard(raw: string, source: 'dgpa'): Dgpa;
export function decodeShard(raw: string, source: 'ncdr'): Alert[];
export function decodeShard(raw: string, source: Source): Dgpa | Alert[];
export function decodeShard(raw: string, source: Source): Dgpa | Alert[] { return source === 'dgpa' ? decodeDgpa(raw) : decodeAlerts(raw); }
