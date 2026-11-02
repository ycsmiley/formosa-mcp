import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TtlCache } from '../core/cache.js';
import { filename } from '../garbage/store.js';
import { collectDisaster, type Store } from '../core/disaster/collect.js';
import { fetchText } from '../core/disaster/http.js';
import { decodeIndex, decodeShard, indexKey, shardKey, type Writer } from '../core/disaster/model.js';
import type { DisasterStore } from '../core/disaster/service.js';
export function localDisasterStore(dir?: string): DisasterStore {
  const values = new Map<string, string>();
  const cache = new TtlCache<Awaited<ReturnType<typeof collectDisaster>>>(result => Object.values(result.index.sources).every(s => s.ok) ? 10 * 60000 : 0);
  const memory: Store = { get: async key => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); } };
  const read = async (key: string) => { if (!dir) return memory.get(key); try { return await readFile(join(dir, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
  const refresh = async () => { if (!dir) await cache.getOrLoad('disaster', () => collectDisaster({ writer: 'gha', store: memory, fetchText: url => fetchText(url, 30000), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), maxCaps: 6 })); };
  const index = async (writer: Writer) => { try { const raw = await read(indexKey(writer)); return raw ? decodeIndex(raw) : null; } catch { return null; } };
  return {
    async indexes() { await refresh(); const [worker, gha] = await Promise.all([index('worker'), index('gha')]); return { worker, gha }; },
    async shard(source, sha) { const raw = await read(shardKey(source, sha)); return raw ? decodeShard(raw, source) : null; },
  };
}
