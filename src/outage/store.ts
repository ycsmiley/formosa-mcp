import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TtlCache } from '../core/cache.js';
import { filename } from '../garbage/store.js';
import { buildShards } from '../core/outage/build.js';
import { decodeIndex, decodeShard, indexKey, shardKey, sources, type Index, type Source, type SourceIndex } from '../core/outage/model.js';
import type { OutageStore } from '../core/outage/service.js';
import { fetchSource } from './source.js';
export function localOutageStore(dir?: string): OutageStore {
  const cache = new TtlCache<{ info: SourceIndex; shards: Map<string, string> }>(value => value.info.ok ? 12 * 3600000 : 0);
  const load = (source: Source) => cache.getOrLoad(source, async () => {
    try {
      const { items } = await fetchSource(source), now = new Date().toISOString(), shards = buildShards(items);
      return { info: { ok: true, fetchedAt: now, lastSuccessAt: now, counties: Object.fromEntries([...shards].map(([c, raw]) => [c, { sha: '0'.repeat(64), count: (JSON.parse(raw) as unknown[]).length, writtenAt: now }])) }, shards };
    } catch (e) { return { info: { ok: false, reason: e instanceof Error ? e.message : '官方開放資料連線失敗', counties: {} }, shards: new Map<string, string>() }; }
  });
  const read = async (key: string) => { try { return await readFile(join(dir!, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
  return {
    async index(relevant = [...sources]) { if (dir) { const raw = await read(indexKey); return raw ? decodeIndex(raw) : null; } return { v: 1, generatedAt: new Date().toISOString(), sources: Object.fromEntries(await Promise.all(relevant.map(async s => [s, (await load(s)).info]))) } as Index; },
    async shard(source, county, sha) { const raw = dir ? await read(shardKey(source, county, sha)) : (await load(source)).shards.get(county); return raw ? decodeShard(raw, source, county) : null; },
  };
}
