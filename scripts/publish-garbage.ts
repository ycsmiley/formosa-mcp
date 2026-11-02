import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { filename } from '../src/garbage/store.js';
import { buildCity } from '../src/core/garbage/build.js';
import { fetchSource, urls } from '../src/garbage/source.js';
import type { City } from '../src/core/garbage/normalize.js';
import { decodeIndex, encodeIndex, indexKey, shardKey, type Index } from '../src/core/garbage/snapshot.js';
export interface Store { get(key: string): Promise<string | null>; put(key: string, value: string, updatedAt: string, ttlSeconds?: number): Promise<void> }
export function directoryStore(dir: string): Store { return { async get(key) { try { return await readFile(join(dir, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }, async put(key, value) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, filename(key)), value); } }; }
export function kvStore(env: Record<string, string | undefined>): Store {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}/values/`;
  const request = (key: string, init: RequestInit = {}, query = '') => fetch(base + encodeURIComponent(key) + query, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_KV_WRITE_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return { async get(key) { const r = await request(key); if (r.status === 404) return null; if (r.status !== 200) throw Error(`kv read failed HTTP ${r.status}`); return r.text(); }, async put(key, value, updatedAt, ttlSeconds) { const body = new FormData(); body.set('value', value); body.set('metadata', JSON.stringify({ updatedAt })); const r = await request(key, { method: 'PUT', body }, ttlSeconds === undefined ? '' : `?expiration_ttl=${ttlSeconds}`); const data = await r.json().catch(() => null); if (r.status !== 200 || data?.success !== true) throw Error(`kv put failed HTTP ${r.status}`); } };
}
const minimum: Record<City, number> = { ntpc: 10000, taipei: 2000, taichung: 8000 };
export async function collectGarbage(store: Store, options: { cities?: City[]; fetch?: (city: City) => Promise<string>; delay?: () => Promise<void>; now?: () => Date; minimum?: Record<City, number>; token?: string } = {}): Promise<number> {
  const reason = (error: unknown) => { const message = error instanceof Error ? error.message : String(error); return (options.token ? message.replaceAll(options.token, '[redacted]') : message).replace(/\s+/g, ' ').slice(0, 200); };
  const cities = options.cities ?? Object.keys(urls) as City[]; let index: Index;
  try { const old = await store.get(indexKey); index = old ? decodeIndex(old) : { v: 2, generatedAt: new Date().toISOString(), cities: {} }; } catch (error) { console.error(`garbage index read failed: ${reason(error)}`); return 1; }
  let failed = false, dirty = false;
  for (let i = 0; i < cities.length; i++) {
    if (i) await (options.delay ?? (() => new Promise<void>(r => setTimeout(r, 2000))))();
    const city = cities[i];
    try {
      const input = await (options.fetch ?? fetchSource)(city); const now = (options.now ?? (() => new Date()))(); const data = await buildCity(city, input, now); const previous = index.cities[city];
      if (data.entry.stops < (options.minimum ?? minimum)[city]) throw Error('minimum guard');
      const changed = Object.keys(data.entry.districts).length !== Object.keys(previous?.districts ?? {}).length || Object.entries(data.entry.districts).some(([d, v]) => previous?.districts[d]?.sha256 !== v.sha256);
      data.entry.updatedAt = changed ? now.toISOString() : previous!.updatedAt;
      // A city owns one immutable generation. Any district change writes a new city;
      // unchanged cities keep their generation and only renew after seven days.
      if (!changed) data.entry.gen = previous!.gen;
      else if (data.entry.gen === previous?.gen) data.entry.gen = (now.getTime() + 1).toString(36);
      const writtenAt = previous?.writtenAt ?? previous?.fetchedAt;
      const renew = !changed && (!writtenAt || now.getTime() - Date.parse(writtenAt) > 7 * 86400000);
      let wrote = false;
      for (const [district, value] of data.shards) {
        const key = shardKey(city, data.entry.gen, district);
        if (!changed && !renew && await store.get(key) === value) continue;
        await store.put(key, value, data.entry.updatedAt, 1209600); wrote = true;
      }
      if (changed || wrote || renew) {
        data.entry.writtenAt = changed || renew ? now.toISOString() : writtenAt;
        index.cities[city] = data.entry; dirty = true;
      }
    } catch (error) { failed = true; console.error(`garbage ${city} failed: ${reason(error)}`); }
  }
  try { if (dirty) { index.generatedAt = (options.now ?? (() => new Date()))().toISOString(); await store.put(indexKey, encodeIndex(index), index.generatedAt); } } catch (error) { console.error(`garbage index write failed: ${reason(error)}`); failed = true; }
  return failed ? 1 : 0;
}
export async function main(args = process.argv.slice(2), env = process.env): Promise<number> {
  let dir: string | undefined, cities: City[] | undefined;
  for (let i = 0; i < args.length; i += 2) { const value = args[i + 1]; if (!value || !['--out', '--city'].includes(args[i]) || (args[i] === '--city' && value.split(',').some(c => !Object.hasOwn(urls, c)))) { console.error('Usage: publish-garbage [--out dir] [--city codes]'); return 2; } if (args[i] === '--out') dir = value; else cities = value.split(',') as City[]; }
  if (!dir && ['CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID', 'CLOUDFLARE_KV_WRITE_TOKEN'].some(k => !env[k]?.trim())) { console.error('garbage KV configuration missing'); return 2; }
  return collectGarbage(dir ? directoryStore(dir) : kvStore(env), { cities, token: env.CLOUDFLARE_KV_WRITE_TOKEN });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
