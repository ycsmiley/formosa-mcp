import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filename } from '../src/garbage/store.js';
import { buildShards } from '../src/core/outage/build.js';
import { taiwaterEmptyReason } from '../src/core/outage/normalize.js';
import { decodeIndex, indexKey, shardKey, sources, type Index, type Source, type SourceIndex } from '../src/core/outage/model.js';
import { fetchSource, type SourceData } from '../src/outage/source.js';
export interface Store { get(key: string): Promise<string | null>; put(key: string, value: string, updatedAt: string, ttlSeconds?: number): Promise<void> }
export function directoryStore(dir: string): Store { return { async get(key) { try { return await readFile(join(dir, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }, async put(key, value) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, filename(key)), value); } }; }
export function kvStore(env: Record<string, string | undefined>): Store {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}/values/`;
  const request = (key: string, init: RequestInit = {}, query = '') => fetch(base + encodeURIComponent(key) + query, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_KV_WRITE_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return { async get(key) { const r = await request(key); if (r.status === 404) return null; if (r.status !== 200) throw Error(`kv read failed HTTP ${r.status}`); return r.text(); }, async put(key, value, updatedAt, ttlSeconds) { const body = new FormData(); body.set('value', value); body.set('metadata', JSON.stringify({ updatedAt })); const r = await request(key, { method: 'PUT', body }, ttlSeconds === undefined ? '' : `?expiration_ttl=${ttlSeconds}`); const data = await r.json().catch(() => null); if (r.status !== 200 || data?.success !== true) throw Error(`kv put failed HTTP ${r.status}`); } };
}
export async function collectOutages(store: Store, options: { fetch?: (source: Source) => Promise<SourceData>; now?: () => Date; token?: string } = {}): Promise<number> {
  const reason = (e: unknown) => (options.token ? String(e instanceof Error ? e.message : e).replaceAll(options.token, '[redacted]') : String(e instanceof Error ? e.message : e)).replace(/https?:\/\/[^\s]+/g, '[url]').replace(/\s+/g, ' ').slice(0, 200);
  let previous: Index; let writes = 0, failed = false;
  try { const raw = await store.get(indexKey); previous = raw ? decodeIndex(raw) : { v: 1, generatedAt: '', sources: {} }; }
  catch (e) { console.error(`outage index read failed: ${reason(e)}`); return 1; }
  const results = await Promise.allSettled(sources.map(s => (options.fetch ?? fetchSource)(s)));
  const index: Index = { v: 1, generatedAt: (options.now ?? (() => new Date()))().toISOString(), sources: {} };
  for (const [i, source] of sources.entries()) {
    const old = previous.sources[source]; let dropped = 0, count = 0, largest = 0;
    let publicationFailed = false;
    try {
      const result = results[i]; if (result.status === 'rejected') throw result.reason;
      const data = result.value; dropped = data.dropped; count = data.items.length;
      if (source === 'taiwater' && data.rows === 0) throw Error(taiwaterEmptyReason);
      const shards = buildShards(data.items), counties: SourceIndex['counties'] = {};
      for (const [county, raw] of shards) {
        const sha = createHash('sha256').update(raw).digest('hex'); largest = Math.max(largest, Buffer.byteLength(raw));
        const prior = old?.counties[county]; let writtenAt = prior?.writtenAt;
        if (prior?.sha !== sha || !writtenAt || Date.parse(index.generatedAt) - Date.parse(writtenAt) > 3 * 86400000) {
          try { await store.put(shardKey(source, county, sha), raw, index.generatedAt, 8 * 86400); }
          catch (e) { publicationFailed = true; throw e; }
          writes++; writtenAt = index.generatedAt;
        }
        counties[county] = { sha, count: data.items.filter(item => item.c === county).length, writtenAt };
      }
      index.sources[source] = { ok: true, fetchedAt: index.generatedAt, lastSuccessAt: index.generatedAt, counties, dropped };
    } catch (e) {
      const emptyTaiwater = source === 'taiwater' && reason(e) === taiwaterEmptyReason;
      const regressed = old?.ok === true && !emptyTaiwater;
      if (publicationFailed || regressed) failed = true;
      index.sources[source] = { ok: false, fetchedAt: index.generatedAt, reason: reason(e), ...(old?.lastSuccessAt ? { lastSuccessAt: old.lastSuccessAt } : {}), counties: old?.counties ?? {}, ...(old?.dropped !== undefined ? { dropped: old.dropped } : {}) };
      if (publicationFailed || regressed) console.error(`outage ${source} failed: ${reason(e)}`);
      else console.warn(`outage ${source} unavailable: ${reason(e)}`);
    }
    console.log(`outage ${source} ok=${index.sources[source]!.ok} count=${count} largestBytes=${largest} dropped=${dropped}`);
  }
  try { await store.put(indexKey, JSON.stringify(index), index.generatedAt); writes++; } catch (e) { console.error(`outage index write failed: ${reason(e)}`); failed = true; }
  console.log(`outage KV writes=${writes}`);
  return failed ? 1 : 0;
}
export async function main(args = process.argv.slice(2), env = process.env): Promise<number> {
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1]?.trim())) { console.error('Usage: publish-outages [--out dir]'); return 2; }
  const dir = args[1];
  if (!dir && ['CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID', 'CLOUDFLARE_KV_WRITE_TOKEN'].some(k => !env[k]?.trim())) { console.error('outage KV configuration missing'); return 2; }
  return collectOutages(dir ? directoryStore(dir) : kvStore(env), { token: env.CLOUDFLARE_KV_WRITE_TOKEN });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
