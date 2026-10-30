import { RailError, readJsonLimited, truncatedNote } from '../core/rail/client.js';
import { attribution, createRailService, type LiveArgs, type RailResult, type TimetableArgs } from '../core/rail/service.js';
import { deriveOD, expandStations, liveAge, renderFallback, snapshotTime, stationKey, timetableKey, type StationsSnapshot, type TimetableSnapshot } from '../core/rail/snapshot.js';
import type { Railway } from '../core/rail/stations.js';
import { parseDate, taipeiNow } from '../core/rail/time.js';
import type { TdxEnv, TdxGateway } from './tdx-gateway.js';

export interface RailEnv extends TdxEnv { TDX_GATEWAY: DurableObjectNamespace<TdxGateway> }
export const gateway = (env: RailEnv) => env.TDX_GATEWAY.get(env.TDX_GATEWAY.idFromName('tdx'));
const userBodyLimit = 4 * 1024 * 1024;
const memo = new WeakMap<KVNamespace, Map<string, { raw: string; data: unknown; until: number }>>();
async function read<T extends StationsSnapshot | TimetableSnapshot>(env: RailEnv, key: string): Promise<T | null> {
  try {
    const raw = await env.SNAPSHOTS.get(key);
    if (!raw) return null;
    let cache = memo.get(env.SNAPSHOTS);
    if (!cache) { cache = new Map(); memo.set(env.SNAPSHOTS, cache); }
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
    const previous = cache.get(key);
    if (previous?.raw === raw) return previous.data as T;
    const data = JSON.parse(raw);
    if (data?.v !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Number.isFinite(Date.parse(data.fetchedAt)) || typeof data.truncated !== 'boolean') return null;
    if (key.startsWith('rail:stations:') ? !Array.isArray(data.stations) || !data.stations.length : !Array.isArray(data.trains) || !data.trains.length) return null;
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { raw, data, until: now + 300_000 });
    return data as T;
  } catch { return null; }
}
const unavailableSnapshot = '時刻表資料尚未準備好，請稍後再試；也可帶自己的 TDX 金鑰查詢。';
const outsideCoverage = '公開網址的時刻表只涵蓋今天與明天（臺北時間）；其他日期可帶自己的 TDX 金鑰查詢（見 README 進階用法）。';
const keyHint = '請同時提供有效的 X-TDX-Client-Id 與 X-TDX-Client-Secret（去除前後空白後，須為 1～256 個可列印 ASCII 字元）。';
const reply = (text: string): RailResult => ({ text: `${text}\n${attribution}` });
function attributed(result: RailResult): RailResult {
  return { ...result, text: result.text.includes(attribution) ? result.text : `${result.text}\n${attribution}` };
}
/** Read and remove credentials before the MCP transport sees the request. */
export function userCredentials(headers: Headers) {
  const id = headers.get('X-TDX-Client-Id'), secret = headers.get('X-TDX-Client-Secret');
  headers.delete('X-TDX-Client-Id'); headers.delete('X-TDX-Client-Secret');
  if (id === null && secret === null) return undefined;
  const valid = (value: string | null): value is string => value !== null && /^[\x20-\x7e]{1,256}$/.test(value.trim());
  return valid(id) && valid(secret) ? { clientId: id.trim(), clientSecret: secret.trim() } : 'invalid';
}
export function workerRail(env: RailEnv, ipKey: string, credentials: ReturnType<typeof userCredentials>) {
  if (credentials === 'invalid') return { timetable: async () => reply(keyHint), live: async () => reply(keyHint) };
  if (credentials) {
    // This service and its token cache belong exclusively to this HTTP request.
    const service = createRailService({ credentials, http: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'manual' });
      return { status: response.status, json: () => readJsonLimited(response, userBodyLimit) };
    } });
    return {
      timetable: async (railway: Railway, args: TimetableArgs) => attributed(await service.timetable(railway, args)),
      live: async (args: LiveArgs) => attributed(await service.live(args)),
    };
  }
  return {
    async timetable(railway: Railway, args: TimetableArgs): Promise<RailResult> {
      try {
        const now = new Date(), date = parseDate(args.date, now);
        const today = taipeiNow(now).date, tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
        if (![today, tomorrow].includes(date)) return reply(outsideCoverage);
        const snapshot = await read<TimetableSnapshot>(env, timetableKey(railway, date));
        if (!snapshot) return reply(unavailableSnapshot);
        const stations = await read<StationsSnapshot>(env, stationKey(railway));
        if (!stations) return reply(`${unavailableSnapshot}\n${snapshotTime(snapshot.fetchedAt)}`);
        const service = createRailService({ get: async path => {
          if (path === (railway === 'THSR' ? '/v2/Rail/THSR/Station' : '/v3/Rail/TRA/Station')) return expandStations(railway, stations);
          const match = /\/OD\/([^/]+)\/to\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/.exec(path);
          if (!match || match[3] !== date) throw new RailError('時刻表資料尚未準備好');
          return deriveOD(railway, snapshot, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
        } });
        const result = await service.timetable(railway, args);
        return { ...result, ...reply(`${result.text.replace(`\n${attribution}`, '')}${snapshot.truncated || stations.truncated ? `\n${truncatedNote}` : ''}\n${snapshotTime(snapshot.fetchedAt)}`) };
      } catch (error) { return reply(error instanceof RailError ? error.message : unavailableSnapshot); }
    },
    async live(args: LiveArgs): Promise<RailResult> {
      const now = new Date(), date = taipeiNow(now).date;
      const yesterday = new Date(Date.parse(`${date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
      const [snapshot, stations, previous] = await Promise.all([read<TimetableSnapshot>(env, timetableKey('TRA', date)), read<StationsSnapshot>(env, stationKey('TRA')), read<TimetableSnapshot>(env, timetableKey('TRA', yesterday))]);
      const fallback = async (reason: string) => ({ text: await renderFallback(args, reason, snapshot, stations, now, previous) });
      if ((args.train_no !== undefined) === (args.station !== undefined)) return reply('請擇一提供 train_no（車次）或 station（車站）');
      const no = args.train_no?.normalize('NFKC').trim();
      if (no !== undefined && !/^\d{1,10}$/.test(no)) return reply('請輸入有效的數字車次');
      if (!env.TDX_CLIENT_ID?.trim() || !env.TDX_CLIENT_SECRET?.trim()) return fallback('nokey');
      try {
        const get = async (path: string) => {
          if (path === '/v3/Rail/TRA/Station') {
            if (!stations) throw new RailError('車站資料尚未準備好');
            return expandStations('TRA', stations);
          }
          const result = await gateway(env).live(path, ipKey);
          if (!result.ok) { failure = result.reason; throw new RailError('即時資料暫時無法使用'); }
          fetchedAt = result.fetchedAt;
          return result.data;
        };
        let fetchedAt = '', failure = '';
        const result = await createRailService({ get }).live(args);
        if (result.isError) return fallback(failure || 'upstream');
        return reply(`${result.text.replace(`\n${attribution}`, '')}\n${liveAge(fetchedAt, new Date())}`);
      } catch { return fallback('upstream'); }
    },
  };
}
