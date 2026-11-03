import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { collectGarbage, directoryStore, main, type Store } from '../scripts/publish-garbage.js';
import { fetchSource } from '../src/garbage/source.js';
import { decodeIndex, decodeShard, indexKey, shardKey } from '../src/core/garbage/snapshot.js';
import type { City } from '../src/core/garbage/normalize.js';
const fixture = (city: string) => readFileSync(`test/fixtures/garbage/real/${city}.${city === 'ntpc' || city === 'taipei' ? 'csv' : 'json'}`, 'utf8');

it('matches a keyword containing an escaped quote in a stop name', () => {
  const raw = ['{"v":2}', JSON.stringify(['文化里', 'A', 'A"B路', [], [], []])].join('\n');
  expect(decodeShard(raw, '板橋區', 'A"B').stops.map(stop => stop.name)).toEqual(['A"B路']);
});
it('prints usage for an unknown city', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { expect(await main(['--city', 'unknown'], {})).toBe(2); expect(await main(['--city', 'tainan'], {})).toBe(2); expect(error).toHaveBeenCalledWith('Usage: publish-garbage [--out dir] [--city codes]'); } finally { error.mockRestore(); }
});
it('selects a city via the CLI and preserves other city entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'garbage-'));
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  try {
    const store = directoryStore(dir);
    expect(await collectGarbage(store, { cities: ['ntpc'], minimum: { ntpc: 1, taipei: 1, taichung: 1 }, fetch: async () => fixture('ntpc') })).toBe(0);
    const previous = decodeIndex((await store.get(indexKey))!).cities.ntpc;
    const [header, row] = fixture('taipei').trim().split(/\r?\n/);
    const fields = row.split(',');
    const csv = [header, ...Array.from({ length: 2001 }, (_, i) => { const copy = [...fields]; copy[9] += ` ${i}`; return copy.join(','); })].join('\n');
    fetchMock.mockResolvedValue(new Response(csv));
    expect(await main(['--out', dir, '--city', 'taipei'], {})).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('data.taipei');
    const index = decodeIndex((await store.get(indexKey))!);
    expect(index.cities.ntpc).toEqual(previous);
    expect(index.cities.taipei!.stops).toBeGreaterThan(0);
  } finally { fetchMock.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
it('collects in order, retains failures, and writes shards before the index', async () => {
  const values = new Map<string, string>(), writes: string[] = [], events: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { writes.push(k); values.set(k, v); } };
  const minimum = Object.fromEntries(['ntpc','taipei','taichung'].map(c => [c, 1])) as Record<City, number>;
  const options = { cities: ['ntpc', 'taipei'] as City[], minimum, now: () => new Date('2026-10-30T00:00:00Z'), fetch: async (c: City) => { events.push(c); return fixture(c); }, delay: async () => { events.push('delay'); } };
  expect(await collectGarbage(store, options)).toBe(0);
  expect(events).toEqual(['ntpc', 'delay', 'taipei']);
  expect(writes.at(-1)).toBe(indexKey);
  const old = decodeIndex(values.get(indexKey)!); const district = Object.keys(old.cities.ntpc!.districts)[0];
  expect(decodeShard(values.get(shardKey('ntpc', old.cities.ntpc!.gen, district))!, district).stops.length).toBeGreaterThan(0);
  writes.length = 0;
  expect(await collectGarbage(store, { ...options, now: () => new Date('2026-10-31T00:00:00Z'), fetch: async c => { if (c === 'ntpc') throw Error('failure'); return fixture(c); } })).toBe(1);
  expect(decodeIndex(values.get(indexKey)!).cities.ntpc).toEqual(old.cities.ntpc);
  expect(writes).toEqual([indexKey]);
  expect(decodeIndex(values.get(indexKey)!).cities.taipei!.updatedAt).toBe(old.cities.taipei!.updatedAt);
  expect(decodeIndex(values.get(indexKey)!).cities.taipei!.checkedAt).toBe('2026-10-31T00:00:00.000Z');
  expect(await collectGarbage(store, { ...options, minimum: { ...minimum, ntpc: 999999 } })).toBe(1);
});
it('aborts an oversized source stream', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); c.close(); } })));
  try { await expect(fetchSource('ntpc')).rejects.toThrow('source too large'); } finally { spy.mockRestore(); }
});

it('does not expose KV tokens when a request fails', async () => {
  const { main } = await import('../scripts/publish-garbage.js');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('secret-token'));
  try {
    expect(await main([], { CLOUDFLARE_ACCOUNT_ID: 'account', KV_NAMESPACE_ID: 'namespace', CLOUDFLARE_KV_WRITE_TOKEN: 'secret-token' })).toBe(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
  } finally { error.mockRestore(); fetchMock.mockRestore(); }
});

it('logs bounded failure reasons with the token redacted', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store: Store = { get: async () => null, put: async () => {} };
    expect(await collectGarbage(store, { cities: ['ntpc'], token: 'secret-token', fetch: async () => { throw Error('bad\n secret-token response'); } })).toBe(1);
    expect(error.mock.calls[0][0]).toBe('garbage ntpc failed: bad [redacted] response');
    error.mockClear();
    expect(await collectGarbage({ ...store, get: async () => { throw Error('HTTP 503 secret-token'); } }, { token: 'secret-token' })).toBe(1);
    expect(error.mock.calls[0][0]).toBe('garbage index read failed: HTTP 503 [redacted]');
  } finally { error.mockRestore(); }
});

it('publishes KV shards before the index and writes only the index on unchanged runs', async () => {
  const { kvStore } = await import('../scripts/publish-garbage.js');
  const values = new Map<string, string>(), writes: string[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url)); const key = decodeURIComponent(parsed.pathname.split('/').at(-1)!);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer token');
    if (!init!.method) return values.has(key) ? new Response(values.get(key)) : new Response(null, { status: 404 });
    expect(parsed.searchParams.get('expiration_ttl')).toBe(key === indexKey ? null : '1209600');
    const body = init!.body as FormData;
    expect(JSON.parse(body.get('metadata') as string).updatedAt).toBe('2026-10-30T00:00:00.000Z');
    writes.push(key); values.set(key, body.get('value') as string);
    return Response.json({ success: true });
  });
  try {
    const store = kvStore({ CLOUDFLARE_ACCOUNT_ID: 'a', KV_NAMESPACE_ID: 'n', CLOUDFLARE_KV_WRITE_TOKEN: 'token' });
    const minimum = Object.fromEntries(['ntpc','taipei','taichung'].map(c => [c, 1])) as Record<City, number>;
    const options = { cities: ['ntpc'] as City[], minimum, fetch: async () => fixture('ntpc'), now: () => new Date('2026-10-30T00:00:00Z') };
    expect(await collectGarbage(store, options)).toBe(0);
    expect(writes.length).toBeGreaterThan(1); expect(writes.at(-1)).toBe(indexKey);
    expect(writes.slice(0, -1).every(k => k.startsWith(`garbage:v2:ntpc:${new Date('2026-10-30T00:00:00Z').getTime().toString(36)}:`))).toBe(true);
    const previous = decodeIndex(values.get(indexKey)!).cities.ntpc!.updatedAt;
    writes.length = 0;
    expect(await collectGarbage(store, options)).toBe(0);
    expect(writes).toEqual([indexKey]);
    expect(decodeIndex(values.get(indexKey)!).cities.ntpc!.updatedAt).toBe(previous);
  } finally { fetchMock.mockRestore(); }
});

it('prefilters a large shard and rejects v1 snapshots', () => {
  const lines = Array.from({ length: 7000 }, (_, i) => JSON.stringify(['其他里', 'A', `地點${i}`, [], [], []]));
  lines[23] = 'invalid JSON without the search term';
  lines[4000] = JSON.stringify(['台北里', 'A', '文化路１號', [], [], []]);
  const raw = ['{"v":2}', ...lines].join('\n');
  expect(decodeShard(raw, '板橋區', '臺北里').stops.map(s => s.name)).toEqual(['文化路１號']);
  expect(decodeShard(raw, '板橋區', '文化路1號').stops).toHaveLength(1);
  expect(() => decodeShard(raw, '板橋區')).toThrow();
  expect(() => decodeShard('{"v":1,"stops":[]}', '板橋區', '文化')).toThrow();
  expect(() => decodeIndex('{"v":1,"generatedAt":"2026-10-30T00:00:00Z","cities":{}}')).toThrow();
});

it('keeps the old generation readable after a partial shard write', async () => {
  const values = new Map<string, string>(); let fail = false, count = 0;
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { if (fail && k !== indexKey && ++count === 2) throw Error('write failed'); values.set(k, v); } };
  const minimum = { ntpc: 1, taipei: 1, taichung: 1 };
  const options = { cities: ['ntpc'] as City[], minimum, fetch: async () => fixture('ntpc') };
  expect(await collectGarbage(store, { ...options, now: () => new Date('2026-10-30T00:00:00Z') })).toBe(0);
  const old = decodeIndex(values.get(indexKey)!).cities.ntpc!;
  const oldShards = Object.keys(old.districts).map(d => values.get(shardKey('ntpc', old.gen, d)));
  expect(oldShards.length).toBeGreaterThan(1);
  fail = true;
  expect(await collectGarbage(store, { ...options, fetch: async () => fixture('ntpc').replace('獅頭路15-1號', '新站點'), now: () => new Date('2026-10-31T00:00:00Z') })).toBe(1);
  expect(decodeIndex(values.get(indexKey)!).cities.ntpc).toEqual(old);
  expect(Object.keys(old.districts).map(d => values.get(shardKey('ntpc', old.gen, d)))).toEqual(oldShards);
});

it('rejects invalid generation identifiers', () => {
  for (const gen of ['', 'ABC', 'a:b', 'a'.repeat(17)]) {
    expect(() => decodeIndex(JSON.stringify({ v: 2, generatedAt: '2026-10-30T00:00:00Z', cities: { ntpc: { gen, fetchedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', stops: 0, districts: {} } } }))).toThrow();
  }
});

it('accepts legacy checkedAt omissions and validates checkedAt when present', () => {
  const entry = { gen: 'abc', fetchedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', stops: 0, districts: {} };
  const encode = (city: object) => JSON.stringify({ v: 2, generatedAt: entry.fetchedAt, cities: { ntpc: city } });
  expect(decodeIndex(encode(entry)).cities.ntpc!.checkedAt).toBeUndefined();
  expect(decodeIndex(encode({ ...entry, checkedAt: entry.fetchedAt })).cities.ntpc!.checkedAt).toBe(entry.fetchedAt);
  for (const checkedAt of ['invalid', '', null, 123]) expect(() => decodeIndex(encode({ ...entry, checkedAt }))).toThrow('Invalid garbage city');
});

it('does not write the index when no city was successfully checked', async () => {
  const put = vi.fn(), error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await collectGarbage({ get: async () => null, put }, { cities: ['ntpc', 'taipei'], delay: async () => {}, fetch: async () => { throw Error('unavailable'); } })).toBe(1);
    expect(put).not.toHaveBeenCalled();
  } finally { error.mockRestore(); }
});

it('prefilters only decoded leading fields and caps matches', () => {
  const row = JSON.stringify(['文化里', 'A', '文化路', [[1, '19:00', '']], [], []]);
  const escaped = JSON.stringify(['文化里', 'A', '文化"路', [], [], []]);
  const raw = ['{"v":2}', row, escaped].join('\n');
  expect(decodeShard(raw, '板橋區', '19:').stops).toHaveLength(0);
  expect(decodeShard(raw, '板橋區', '",').stops).toHaveLength(0);
  expect(decodeShard(raw, '板橋區', '文化"路').stops).toHaveLength(1);
  const many = ['{"v":2}', ...Array(201).fill(row)].join('\n');
  expect(decodeShard(many, '板橋區', '文化')).toMatchObject({ truncated: true, stops: Array(200).fill(expect.any(Object)) });
  expect(decodeShard(['{"v":2}', ...Array(200).fill(row)].join('\n'), '板橋區', '文化').truncated).toBeUndefined();
});

it('drops legacy cities from indexes and rejects other unknown cities', () => {
  const entry = { gen: 'abc', fetchedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', stops: 0, districts: {}, capturedWeekday: 5 };
  const index = { v: 2, generatedAt: entry.fetchedAt, cities: { ntpc: entry, tainan: entry, kaohsiung: entry } };
  expect(Object.keys(decodeIndex(JSON.stringify(index)).cities)).toEqual(['ntpc']);
  expect(() => decodeIndex(JSON.stringify({ ...index, cities: { ...index.cities, unknown: entry } }))).toThrow();
});

it('keeps unchanged generations, repairs missing/corrupt shards, and renews only after seven days', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { values.set(k, v); writes.push(k); } };
  let clock = Date.parse('2026-10-30T00:00:00Z');
  const options = { cities: ['ntpc'] as City[], fetch: async () => fixture('ntpc'), now: () => new Date(clock), minimum: { ntpc: 1, taipei: 1, taichung: 1 } };
  await collectGarbage(store, options); const first = decodeIndex(values.get(indexKey)!).cities.ntpc!;
  const keys = Object.keys(first.districts).map(d => shardKey('ntpc', first.gen, d));
  writes.length = 0; clock += 86400000; await collectGarbage(store, options);
  expect(writes).toEqual([indexKey]);
  expect(decodeIndex(values.get(indexKey)!).cities.ntpc).toEqual({ ...first, checkedAt: new Date(clock).toISOString() });
  expect(decodeIndex(values.get(indexKey)!).generatedAt).toBe(new Date(clock).toISOString());
  for (const corrupt of [null, 'corrupt']) {
    if (corrupt === null) values.delete(keys[0]); else values.set(keys[0], corrupt);
    writes.length = 0; await collectGarbage(store, options);
    expect(writes).toEqual([keys[0], indexKey]);
    // Repairing one shard must not postpone renewal of the remaining shards.
    expect(decodeIndex(values.get(indexKey)!).cities.ntpc!.writtenAt).toBe(first.writtenAt);
  }
  writes.length = 0; clock = Date.parse(first.writtenAt!) + 7 * 86400000;
  await collectGarbage(store, options); expect(writes).toEqual([indexKey]);
  writes.length = 0; clock++; await collectGarbage(store, options); expect(writes).toEqual([...keys, indexKey]);
  const renewed = decodeIndex(values.get(indexKey)!).cities.ntpc!;
  expect(renewed.gen).toBe(first.gen); expect(renewed.updatedAt).toBe(first.updatedAt); expect(renewed.writtenAt).toBe(new Date(clock).toISOString());
});
it('writes every district of a changed city and preserves references for other cities', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { values.set(k, v); writes.push(k); } };
  const options = { cities: ['ntpc', 'taipei'] as City[], fetch: async (c: City) => fixture(c), delay: async () => {}, now: () => new Date('2026-10-30T00:00:00Z'), minimum: { ntpc: 1, taipei: 1, taichung: 1 } };
  await collectGarbage(store, options); const first = decodeIndex(values.get(indexKey)!);
  writes.length = 0;
  await collectGarbage(store, { ...options, now: () => new Date('2026-10-31T00:00:00Z'), fetch: async c => fixture(c).replace('獅頭路15-1號', '新站點') });
  const next = decodeIndex(values.get(indexKey)!);
  expect(next.cities.ntpc!.gen).not.toBe(first.cities.ntpc!.gen); expect(next.cities.taipei).toEqual({ ...first.cities.taipei, checkedAt: '2026-10-31T00:00:00.000Z' });
  expect(writes).toEqual([...Object.keys(next.cities.ntpc!.districts).map(d => shardKey('ntpc', next.cities.ntpc!.gen, d)), indexKey]);
});
it('renews legacy cities from fetchedAt when writtenAt is absent', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { values.set(k, v); writes.push(k); } };
  const at = Date.parse('2026-10-30T00:00:00Z');
  const options = { cities: ['ntpc'] as City[], fetch: async () => fixture('ntpc'), now: () => new Date(at), minimum: { ntpc: 1, taipei: 1, taichung: 1 } };
  await collectGarbage(store, options);
  const legacy = decodeIndex(values.get(indexKey)!); delete legacy.cities.ntpc!.writtenAt; values.set(indexKey, JSON.stringify(legacy));
  writes.length = 0; await collectGarbage(store, options); expect(writes).toEqual([indexKey]);
  writes.length = 0;
  await collectGarbage(store, { ...options, now: () => new Date(at + 8 * 86400000) });
  expect(writes.length).toBe(Object.keys(legacy.cities.ntpc!.districts).length + 1);
  expect(decodeIndex(values.get(indexKey)!).cities.ntpc!.gen).toBe(legacy.cities.ntpc!.gen);
});
it('stops garbage publication after the daily index write cap', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { values.set(k, v); writes.push(k); } };
  const fetch = vi.fn(async () => fixture('ntpc')), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const options = { cities: ['ntpc'] as City[], fetch, minimum: { ntpc: 1, taipei: 1, taichung: 1 }, now: () => new Date('2026-10-30T23:59:00Z') };
  try {
    for (let i = 0; i < 3; i++) expect(await collectGarbage(store, options)).toBe(0);
    expect(decodeIndex(values.get(indexKey)!).indexWrites).toEqual({ day: '2026-10-30', count: 3 });
    writes.length = 0; fetch.mockClear();
    // Even a missing shard must remain untouched once publication is capped.
    values.delete([...values.keys()].find(key => key !== indexKey)!);
    expect(await collectGarbage(store, options)).toBe(0);
    expect(fetch).not.toHaveBeenCalled(); expect(writes).toEqual([]); expect(log).toHaveBeenCalledWith('garbage daily index write cap reached');
  } finally { log.mockRestore(); }
});
it('resets the garbage index write cap on a new UTC day', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { values.set(k, v); writes.push(k); } };
  let clock = Date.parse('2026-10-30T23:59:00Z');
  const fetch = vi.fn(async () => fixture('ntpc')), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const options = { cities: ['ntpc'] as City[], fetch, minimum: { ntpc: 1, taipei: 1, taichung: 1 }, now: () => new Date(clock), maxIndexWritesPerDay: 1 };
  try {
    await collectGarbage(store, options); writes.length = 0; fetch.mockClear();
    expect(await collectGarbage(store, options)).toBe(0); expect(fetch).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    clock += 60000;
    expect(await collectGarbage(store, options)).toBe(0); expect(fetch).toHaveBeenCalledOnce(); expect(writes).toEqual([indexKey]);
    expect(decodeIndex(values.get(indexKey)!).indexWrites).toEqual({ day: '2026-10-31', count: 1 });
  } finally { log.mockRestore(); }
});
it('accepts legacy garbage indexes and validates optional daily write counters', () => {
  const old = { v: 2, generatedAt: '2026-10-30T00:00:00Z', cities: {} };
  expect(decodeIndex(JSON.stringify(old)).indexWrites).toBeUndefined();
  expect(decodeIndex(JSON.stringify({ ...old, indexWrites: { day: '2026-10-30', count: 0 } })).indexWrites!.count).toBe(0);
  for (const indexWrites of [null, [], { day: '2026-02-30', count: 1 }, { day: '2026-10-30T00:00:00Z', count: 1 }, { day: '2026-10-30', count: -1 }, { day: '2026-10-30', count: 1.5 }, { day: '2026-10-30', count: '1' }]) expect(() => decodeIndex(JSON.stringify({ ...old, indexWrites }))).toThrow();
});
