export const sources = ['taiwater', 'taipeiwater', 'taipower'] as const;
export type Source = typeof sources[number];
export type Times = [string, string][] | string;
export interface Item { s: Source; k: 'water' | 'power'; c: string; d: string; t: Times; a: string; r: string; n: string; u: string; o?: string }
export interface SourceIndex { ok: boolean; reason?: string; fetchedAt?: string; lastSuccessAt?: string; counties: Record<string, { sha: string; count: number }> }
export interface Index { v: 1; generatedAt: string; sources: Partial<Record<Source, SourceIndex>> }
export const indexKey = 'outage:index:v1';
export const shardKey = (source: Source, county: string) => `outage:v1:${source}:${county}`;
export const official: Record<Source, { name: string; url: string }> = {
  taiwater: { name: '台水', url: 'https://web.water.gov.tw/wateroff/' },
  taipeiwater: { name: '北水', url: 'https://web.water.gov.taipei/' },
  taipower: { name: '台電', url: 'https://www.taipower.com.tw/' },
};
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const timestamp = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x));
export function decodeIndex(raw: string): Index {
  const x: unknown = JSON.parse(raw);
  if (!object(x) || x.v !== 1 || !timestamp(x.generatedAt) || !object(x.sources)) throw Error('公告索引格式錯誤');
  for (const [s, v] of Object.entries(x.sources)) {
    if (!sources.includes(s as Source) || !object(v) || typeof v.ok !== 'boolean' || !object(v.counties) || (v.reason !== undefined && typeof v.reason !== 'string') || [v.fetchedAt, v.lastSuccessAt].some(t => t !== undefined && !timestamp(t))) throw Error('公告來源格式錯誤');
    for (const [c, shard] of Object.entries(v.counties)) if (!c || !object(shard) || !/^[a-f0-9]{64}$/.test(shard.sha) || !Number.isSafeInteger(shard.count) || shard.count < 0) throw Error('公告縣市格式錯誤');
  }
  return x as unknown as Index;
}
export function decodeShard(raw: string, source: Source, county: string): Item[] {
  const x: unknown = JSON.parse(raw);
  if (!Array.isArray(x)) throw Error('公告資料格式錯誤');
  for (const v of x) {
    if (!object(v) || v.s !== source || v.c !== county || v.k !== (source === 'taipower' ? 'power' : 'water') || !['d', 'a', 'r', 'n', 'u'].every(k => typeof v[k] === 'string') || (v.o !== undefined && typeof v.o !== 'string')) throw Error('公告項目格式錯誤');
    if (typeof v.t !== 'string' && (!Array.isArray(v.t) || !v.t.length || !v.t.every((t: unknown) => Array.isArray(t) && t.length === 2 && t.every(v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(v)) && t[0] <= t[1]))) throw Error('公告時間格式錯誤');
  }
  return x as Item[];
}
