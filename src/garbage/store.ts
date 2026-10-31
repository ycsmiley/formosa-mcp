import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TtlCache } from '../core/cache.js';
import type { City } from '../core/garbage/normalize.js';
import { buildCity } from '../core/garbage/build.js';
import { decodeIndex, decodeShard, indexKey, shardKey, type Index } from '../core/garbage/snapshot.js';
import type { GarbageStore } from '../core/garbage/service.js';
import { fetchSource } from './source.js';
export const filename = (key: string) => `${key.replaceAll(':', '_')}.json`;
export function localGarbageStore(dir?: string): GarbageStore {
  const cache = new TtlCache<Awaited<ReturnType<typeof buildCity>>>(12 * 3600000);
  const load = (city: City) => cache.getOrLoad(city, async () => buildCity(city, await fetchSource(city), new Date()));
  const read = async (key: string) => { try { return await readFile(join(dir!, filename(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
  return {
    async index(city) { if (dir) { const raw = await read(indexKey); return raw ? decodeIndex(raw) : null; } if (!city) return null; const data = await load(city); return { v: 2, generatedAt: data.entry.fetchedAt, cities: { [city]: data.entry } } as Index; },
    async shard(city, gen, district, keyword, filter) { const raw = dir ? await read(shardKey(city, gen, district)) : (await load(city)).shards.get(district); return raw ? decodeShard(raw, district, keyword, filter) : null; },
  };
}
