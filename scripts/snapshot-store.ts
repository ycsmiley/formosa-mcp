import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filename } from '../src/garbage/store.js';
export interface Store { get(key: string): Promise<string | null>; put(key: string, value: string, updatedAt: string, ttlSeconds?: number): Promise<void> }
export function directoryStore(dir: string): Store { return { async get(key) { try { return await readFile(join(dir, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }, async put(key, value) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, filename(key)), value); } }; }
export function kvStore(env: Record<string, string | undefined>): Store {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}/values/`;
  const request = (key: string, init: RequestInit = {}, query = '') => fetch(base + encodeURIComponent(key) + query, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_KV_WRITE_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return { async get(key) { const r = await request(key); if (r.status === 404) return null; if (r.status !== 200) throw Error(`kv read failed HTTP ${r.status}`); return r.text(); }, async put(key, value, updatedAt, ttlSeconds) { const body = new FormData(); body.set('value', value); body.set('metadata', JSON.stringify({ updatedAt })); const r = await request(key, { method: 'PUT', body }, ttlSeconds === undefined ? '' : `?expiration_ttl=${ttlSeconds}`); const data = await r.json().catch(() => null); if (r.status !== 200 || data?.success !== true) throw Error(`kv put failed HTTP ${r.status}`); } };
}
