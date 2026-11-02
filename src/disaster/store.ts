import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TtlCache } from '../core/cache.js';
import { filename } from '../garbage/store.js';
import { collectDisaster, type Store } from '../core/disaster/collect.js';
import { fetchText } from '../core/disaster/http.js';
import { decodeIndex, decodeShard, indexKey, shardKey, sources, type Source, type Writer, type Index } from '../core/disaster/model.js';
import type { DisasterStore } from '../core/disaster/service.js';
export function localDisasterStore(dir?: string): DisasterStore {
  const memoryStore = (): Store => {
    const values = new Map<string, string>();
    return { get: async key => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); } };
  };
  // Separate stores isolate index writes: DGPA never waits on an in-flight NCDR run.
  const memory = { dgpa: memoryStore(), ncdr: memoryStore() };
  // Source keys keep TTLs and in-flight promises independent too.
  const cache = new TtlCache<Awaited<ReturnType<typeof collectDisaster>>>(result => Object.values(result.index.sources).every(s => s.ok) ? 10 * 60000 : 2 * 60000);
  const read = async (key: string, source: Source) => { if (!dir) return memory[source].get(key); try { return await readFile(join(dir, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
  const refresh = async (source: Source) => { if (!dir) await cache.getOrLoad(source, () => collectDisaster({ writer: 'gha', store: memory[source], only: [source], fetchText: url => fetchText(url, 12000), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), maxCaps: 6 })); };
  const index = async (writer: Writer, source: Source) => { const raw = await read(indexKey(writer), source); return raw === null ? null : decodeIndex(raw); };
  return {
    async indexes(source) {
      const selected = source ? [source] : sources;
      await Promise.all(selected.map(refresh));
      const load = async (writer: Writer): Promise<Index | null> => {
        if (dir) return index(writer, selected[0]);
        const indexes = await Promise.all(selected.map(s => index(writer, s)));
        const first = indexes.find((i): i is Index => i !== null);
        return first ? { ...first, sources: Object.assign({}, ...indexes.map(i => i?.sources)) } : null;
      };
      const [worker, gha] = await Promise.allSettled([load('worker'), load('gha')]);
      return { worker: worker.status === 'fulfilled' ? worker.value : null, gha: gha.status === 'fulfilled' ? gha.value : null, error: worker.status === 'rejected' || gha.status === 'rejected' };
    },
    async shard(source, sha) { const raw = await read(shardKey(source, sha), source); return raw ? decodeShard(raw, source) : null; },
  };
}
