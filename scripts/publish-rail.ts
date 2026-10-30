import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotReserve } from '../src/core/rail/budget.js';
import { object, string, tdxApiUrl, tdxBase, tokenBody, tokenPath } from '../src/core/rail/client.js';
import { compactStations, compactTimetable, stationKey, timetableKey } from '../src/core/rail/snapshot.js';
import type { Railway } from '../src/core/rail/stations.js';
import { taipeiNow } from '../src/core/rail/time.js';
import { snapshotUsageKey } from '../src/worker/snapshot-keys.js';

type Metadata = { fetchedAt: string; dataDate: string };
type PutOptions = { ttlSeconds?: number; metadata: Metadata };
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: PutOptions): Promise<void>;
}
const filename = (key: string) => key.replaceAll(':', '_');
export function directoryStore(dir: string): Store {
  return {
    async get(key) {
      try { return await readFile(join(dir, `${filename(key)}.json`), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('directory read failed'); }
    },
    async put(key, value, { metadata }) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${filename(key)}.json`), value, 'utf8');
      await writeFile(join(dir, `${filename(key)}.meta.json`), JSON.stringify(metadata), 'utf8');
    },
  };
}
function kvStore(env: Record<string, string | undefined>): Store {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}/values/`;
  const request = (key: string, suffix = '', init: RequestInit = {}) => fetch(`${base}${encodeURIComponent(key)}${suffix}`, {
    ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_KV_WRITE_TOKEN}` },
    signal: AbortSignal.timeout(30_000), redirect: 'manual',
  });
  return {
    async get(key) {
      const response = await request(key);
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error('kv read failed');
      return response.text();
    },
    async put(key, value, { ttlSeconds, metadata }) {
      const body = new FormData();
      body.set('value', value);
      body.set('metadata', JSON.stringify(metadata));
      const response = await request(key, ttlSeconds === undefined ? '' : `?expiration_ttl=${ttlSeconds}`, { method: 'PUT', body });
      const result = await response.json().catch(() => null);
      // Never log response bodies, error messages or request headers (including credentials).
      if (response.status !== 200 || result?.success !== true) throw new Error('kv put failed');
    },
  };
}
class CallLimit extends Error {}
interface Usage { v: 1; month: string; days: Record<string, number>; total: number; updatedAt: string }
function usageRecord(raw: string | null, month: string, updatedAt: string): Usage {
  try {
    const data = JSON.parse(raw ?? 'null');
    if (data?.v === 1 && data.month === month && Number.isSafeInteger(data.total) && data.total >= 0 &&
        data.days && typeof data.days === 'object' && !Array.isArray(data.days) &&
        Object.entries(data.days).every(([day, n]) => day.startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isSafeInteger(n) && (n as number) >= 0)) return data;
  } catch { /* Invalid or absent usage starts at zero. */ }
  return { v: 1, month, days: {}, total: 0, updatedAt };
}
export async function publishRail({ outDir, bulkFile, intervalMs = 15_000, maxCalls = Infinity, env = process.env, now = new Date() }: {
  outDir?: string; bulkFile?: string; intervalMs?: number; maxCalls?: number;
  env?: Record<string, string | undefined>; now?: Date;
} = {}): Promise<number> {
  const clientId = env.TDX_CLIENT_ID?.trim(), clientSecret = env.TDX_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.log('::notice::rail snapshot skipped: TDX_CLIENT_ID/TDX_CLIENT_SECRET not set'); return 0;
  }
  if (!outDir) {
    const missing = ['CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID', 'CLOUDFLARE_KV_WRITE_TOKEN'].filter(name => !env[name]?.trim());
    if (missing.length) { console.error(missing.join('\n')); return 2; }
  }
  if (bulkFile && !outDir) { console.error('--wrangler-bulk requires --out'); return 2; }
  const store = outDir ? directoryStore(outDir) : kvStore(env);
  const started = Date.now(), today = taipeiNow(now).date, month = today.slice(0, 7);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const usageKey = snapshotUsageKey(month), reserve = snapshotReserve(env.TDX_SNAPSHOT_RESERVE);
  let calls = 0, bytes = 0, failed = false, lastCall: number | undefined, warned = false;
  let token: { value: string; until: number } | undefined;
  const written: { key: string; value: string; expiration_ttl?: number }[] = [];
  async function put(key: string, value: string, options: PutOptions) {
    await store.put(key, value, options);
    const size = Buffer.byteLength(value);
    bytes += size;
    written.push({ key, value, ...(options.ttlSeconds === undefined ? {} : { expiration_ttl: options.ttlSeconds }) });
    console.log(`rail put ${key} bytes=${size}`);
  }
  let usage: Usage | undefined;
  try {
    usage = usageRecord(await store.get(usageKey), month, now.toISOString());
    async function request(url: string, init: RequestInit = {}) {
      if (usage!.total + calls + 1 > reserve) {
        if (!warned) { console.warn('::warning::rail snapshot monthly reserve exhausted'); warned = true; }
        throw new CallLimit();
      }
      if (calls >= maxCalls) throw new CallLimit();
      if (lastCall !== undefined) {
        const wait = intervalMs - (Date.now() - lastCall);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      }
      lastCall = Date.now(); calls++;
      return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    }
    async function accessToken() {
      if (token && token.until > Date.now()) return token.value;
      const response = await request(`${tdxBase(env.TDX_BASE_URL)}${tokenPath}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody({ clientId: clientId!, clientSecret: clientSecret! }),
      });
      if (response.status !== 200) throw new Error('token failed');
      const data = object(await response.json()), value = string(data.access_token);
      if (!value) throw new Error('invalid token');
      if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`);
      const expiry = data.expires_in ?? 86400;
      if ((data.token_type !== undefined && data.token_type !== 'Bearer') || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) throw new Error('invalid token');
      token = { value, until: Date.now() + Math.max(0, expiry - Math.min(60, expiry / 10)) * 1000 };
      return value;
    }
    async function get(path: string, query?: Record<string, string>) {
      for (let attempt = 0; ; attempt++) {
        const access = await accessToken();
        const response = await request(tdxApiUrl(path, tdxBase(env.TDX_BASE_URL), query), { headers: { authorization: `Bearer ${access}` } });
        if (response.status === 401) { token = undefined; if (attempt === 0) continue; }
        if (response.status !== 200) throw new Error('data failed');
        return response.json();
      }
    }
    async function collect(railway: Railway, date?: string) {
      const key = date ? timetableKey(railway, date) : stationKey(railway);
      try {
        const old = await store.get(key);
        if (date ? old !== null : freshStations(old)) { console.log(`rail skip ${key} exists`); return; }
        let snapshot;
        if (!date) {
          const body = await get(railway === 'THSR' ? '/v2/Rail/THSR/Station' : '/v3/Rail/TRA/Station');
          snapshot = compactStations(railway, body, now.toISOString());
        } else {
          const path = railway === 'THSR' ? `/v2/Rail/THSR/DailyTimetable/TrainDate/${date}` : `/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}`;
          let body = await get(path), truncated = false;
          if (railway === 'TRA') {
            const trains: unknown[] = [];
            for (let page = 0; page < 3; page++) {
              if (page) body = await get(path, { '$skip': String(page * 1000) });
              const rows = object(body).TrainTimetables;
              if (!Array.isArray(rows)) throw new Error('invalid timetable');
              trains.push(...rows);
              if (rows.length < 1000) break;
              if (page === 2) truncated = true;
            }
            body = { TrainTimetables: trains };
          }
          snapshot = compactTimetable(railway, body, date, now.toISOString(), truncated);
        }
        await put(key, JSON.stringify(snapshot), { ...(date ? { ttlSeconds: 259200 } : {}), metadata: { fetchedAt: snapshot.fetchedAt, dataDate: snapshot.date } });
      } catch (error) {
        if (error instanceof CallLimit) console.log(`rail skip ${key} call limit`);
        else { failed = true; console.error(`rail skip ${key} failed`); }
      }
    }
    function freshStations(raw: string | null) {
      try {
        const data = JSON.parse(raw ?? 'null');
        return data?.v === 1 && /^\d{4}-\d{2}-\d{2}$/.test(data.date) && typeof data.truncated === 'boolean' &&
          Array.isArray(data.stations) && data.stations.length > 0 && Number.isFinite(Date.parse(data.fetchedAt)) && now.getTime() - Date.parse(data.fetchedAt) <= 7 * 86400_000;
      } catch { return false; }
    }
    await collect('THSR', today);
    await collect('TRA', today);
    await collect('THSR');
    await collect('TRA');
    await collect('THSR', tomorrow);
    await collect('TRA', tomorrow);
  } catch { failed = true; console.error(`rail skip ${usageKey} read failed`); }
  finally {
    if (calls > 0 && usage) {
      usage.total += calls; usage.days[today] = (usage.days[today] ?? 0) + calls; usage.updatedAt = new Date().toISOString();
      try { await put(usageKey, JSON.stringify(usage), { ttlSeconds: 62 * 86400, metadata: { fetchedAt: usage.updatedAt, dataDate: today } }); }
      catch { failed = true; console.error(`rail skip ${usageKey} put failed`); }
    }
    if (bulkFile) {
      try { await writeFile(bulkFile, JSON.stringify(written), 'utf8'); }
      catch { failed = true; console.error('rail bulk write failed'); }
    }
    console.log(`rail collector calls=${calls} elapsedMs=${Date.now() - started} bytes=${bytes}`);
  }
  return failed ? 1 : 0;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  const options: { outDir?: string; bulkFile?: string; intervalMs?: number; maxCalls?: number } = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!value || value.startsWith('--') || !['--out', '--wrangler-bulk', '--interval-ms', '--max-calls'].includes(flag) ||
        (['--interval-ms', '--max-calls'].includes(flag) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) {
      console.error('Usage: publish-rail [--out <dir>] [--wrangler-bulk <file>] [--interval-ms N] [--max-calls N]'); return 2;
    }
    if (flag === '--out') options.outDir = value;
    if (flag === '--wrangler-bulk') options.bulkFile = value;
    if (flag === '--interval-ms') options.intervalMs = Number(value);
    if (flag === '--max-calls') options.maxCalls = Number(value);
  }
  return publishRail(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
