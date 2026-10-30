import { object, RailError, tdxApiUrl, tdxBase, truncatedNote } from '../core/rail/client.js';
import { attribution, createRailService, type LiveArgs, type RailResult, type TimetableArgs } from '../core/rail/service.js';
import { compactStations, compactTimetable, deriveOD, expandStations, liveAge, renderFallback, snapshotTime, stationKey, timetableKey, type StationsSnapshot, type TimetableSnapshot } from '../core/rail/snapshot.js';
import type { Railway } from '../core/rail/stations.js';
import { parseDate, taipeiNow } from '../core/rail/time.js';
import type { TdxEnv, TdxGateway } from './tdx-gateway.js';

export interface RailEnv extends TdxEnv { TDX_GATEWAY: DurableObjectNamespace<TdxGateway> }
export const gateway = (env: RailEnv) => env.TDX_GATEWAY.get(env.TDX_GATEWAY.idFromName('tdx'));
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
    const service = createRailService({ credentials, http: (url, init) => fetch(url, { ...init, redirect: 'manual' }) });
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
        return reply(`${result.text.replace(`\n${attribution}`, '')}${snapshot.truncated || stations.truncated ? `\n${truncatedNote}` : ''}\n${snapshotTime(snapshot.fetchedAt)}`);
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
export async function refreshRail(env: RailEnv, now = new Date()) {
  if (!env.TDX_CLIENT_ID?.trim() || !env.TDX_CLIENT_SECRET?.trim()) {
    console.warn('rail snapshot skipped: no project TDX key');
    return;
  }
  const stub = gateway(env);
  async function get(path: string, query?: Record<string, string>): Promise<unknown> {
    for (let waits = 0, retries = 0; ;) {
      const admitted = await stub.acquire('snapshot');
      if (!admitted.ok) {
        if (admitted.reason === 'minute' && waits < 3) {
          waits++;
          await new Promise(resolve => setTimeout(resolve, Math.min(60_000, Math.max(1, admitted.retryAfterMs ?? 60_000))));
          continue;
        }
        throw new RailError('snapshot unavailable');
      }
      const response = await fetch(tdxApiUrl(path, tdxBase(env.TDX_BASE_URL), query), {
        headers: { authorization: `Bearer ${admitted.token}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401) {
        await stub.invalidate(admitted.token);
        if (retries++ === 0) continue;
      }
      if (response.status !== 200) throw new RailError('snapshot unavailable');
      return response.json();
    }
  }
  const today = taipeiNow(now).date, tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  for (const railway of ['THSR', 'TRA'] as const) {
    const key = stationKey(railway);
    try {
      const old = await read<StationsSnapshot>(env, key);
      if (!old || now.getTime() - Date.parse(old.fetchedAt) > 7 * 86400_000) {
        const body = await get(railway === 'THSR' ? '/v2/Rail/THSR/Station' : '/v3/Rail/TRA/Station');
        await env.SNAPSHOTS.put(key, JSON.stringify(compactStations(railway, body, new Date().toISOString())));
      }
    } catch { console.warn(`rail snapshot skipped: ${railway} stations unavailable`); }
    for (const date of [today, tomorrow]) {
      const key = timetableKey(railway, date);
      try {
        if (await env.SNAPSHOTS.get(key) !== null) continue;
        const path = railway === 'THSR' ? `/v2/Rail/THSR/DailyTimetable/TrainDate/${date}` : `/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}`;
        let body = await get(path), truncated = false;
        if (railway === 'TRA') {
          const trains: unknown[] = [];
          for (let page = 0; page < 3; page++) {
            if (page) body = await get(path, { '$skip': String(page * 1000) });
            const rows = object(body).TrainTimetables;
            if (!Array.isArray(rows)) throw new RailError('invalid timetable');
            trains.push(...rows);
            if (rows.length < 1000) break;
            if (page === 2) truncated = true;
          }
          body = { TrainTimetables: trains };
        }
        const snapshot = compactTimetable(railway, body, date, new Date().toISOString(), truncated);
        await env.SNAPSHOTS.put(key, JSON.stringify(snapshot), { expirationTtl: 3 * 86400 });
      } catch { console.warn(`rail snapshot skipped: ${railway} ${date} unavailable`); }
    }
  }
  try {
    const usage = await stub.usage();
    await env.SNAPSHOTS.put('tdx:usage:v1', JSON.stringify(usage));
    console.log(`tdx usage ${JSON.stringify(usage)}`);
    if (usage.pct >= 70) console.warn('tdx usage at least 70%');
  } catch { console.warn('tdx usage unavailable'); }
}
