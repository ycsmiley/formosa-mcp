import type { Clock } from '../clock.js';
import { list, object, RailError, railRowLimit, string, truncatedNote, unavailable } from './client.js';

export type Railway = 'THSR' | 'TRA';
export interface Station { id: string; name: string; english: string }
interface StationList { rows: Station[]; truncated: boolean }
export const normalize = (s: string) => s.normalize('NFKC').trim().replace(/(?:車站|站)$/, '').replaceAll('台', '臺').toLowerCase();
export function createStations(get: (path: string) => Promise<unknown>, clock: Clock) {
  const cache = new Map<Railway, StationList & { until: number }>();
  const pending = new Map<Railway, Promise<StationList>>();
  async function load(railway: Railway) {
    const cached = cache.get(railway);
    if (cached && clock().getTime() < cached.until) return cached;
    const inflight = pending.get(railway);
    if (inflight) return inflight;
    const request = (async () => {
      const data = await get(railway === 'THSR' ? '/v2/Rail/THSR/Station' : '/v3/Rail/TRA/Station');
      const source = list(railway === 'THSR' ? data : object(data).Stations);
      const rows = source.map(value => {
        const row = object(value), name = object(row.StationName);
        return { id: string(row.StationID), name: string(name.Zh_tw), english: string(name.En) };
      }).filter(s => s.id && s.name);
      if (!rows.length) throw new RailError(unavailable);
      const result = { rows, truncated: source.length === railRowLimit };
      cache.set(railway, { ...result, until: clock().getTime() + 86400_000 });
      return result;
    })();
    pending.set(railway, request);
    try { return await request; } finally { pending.delete(railway); }
  }
  return async (railway: Railway, input: string) => {
    const { rows, truncated } = await load(railway);
    let key = normalize(input), note = '';
    if (key === '北車') key = '臺北';
    if (railway === 'THSR' && key === '高雄') { key = '左營'; note = '高鐵高雄站為左營站'; }
    const station = rows.find(s => normalize(s.id) === key || normalize(s.name) === key || (s.english && normalize(s.english) === key));
    if (!key || !station) {
      const suggestions = key ? rows.filter(s => [normalize(s.name), normalize(s.english)].some(n => n && (n.includes(key) || key.includes(n)))).slice(0, 5) : [];
      throw new RailError(`找不到車站「${input}」${suggestions.length ? `，建議：${suggestions.map(s => s.name).join('、')}` : '，請輸入完整站名或車站代碼'}${truncated ? `\n${truncatedNote}` : ''}`);
    }
    return { ...station, note, truncated };
  };
}
