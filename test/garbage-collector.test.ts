import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { collectGarbage, type Store } from '../scripts/publish-garbage.js';
import { fetchSource } from '../src/garbage/source.js';
import { decodeIndex, decodeShard, indexKey, shardKey } from '../src/core/garbage/snapshot.js';
import type { City } from '../src/core/garbage/normalize.js';
const fixture = (city: string) => readFileSync(`test/fixtures/garbage/real/${city}.${city === 'ntpc' || city === 'taipei' ? 'csv' : 'json'}`, 'utf8');
it('collects in order, retains failures, and writes shards before the index', async () => {
  const values = new Map<string, string>(), writes: string[] = [], events: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { writes.push(k); values.set(k, v); } };
  const minimum = Object.fromEntries(['ntpc','taipei','taichung','tainan','kaohsiung'].map(c => [c, 1])) as Record<City, number>;
  const options = { cities: ['ntpc', 'taipei'] as City[], minimum, now: () => new Date('2026-10-30T00:00:00Z'), fetch: async (c: City) => { events.push(c); return fixture(c); }, delay: async () => { events.push('delay'); } };
  expect(await collectGarbage(store, options)).toBe(0);
  expect(events).toEqual(['ntpc', 'delay', 'taipei']);
  expect(writes.at(-1)).toBe(indexKey);
  const old = decodeIndex(values.get(indexKey)!); const district = Object.keys(old.cities.ntpc!.districts)[0];
  expect(decodeShard(values.get(shardKey('ntpc', old.cities.ntpc!.gen, district))!, district).stops.length).toBeGreaterThan(0);
  writes.length = 0;
  expect(await collectGarbage(store, { ...options, now: () => new Date('2026-10-31T00:00:00Z'), fetch: async c => { if (c === 'ntpc') throw Error('failure'); return fixture(c); } })).toBe(1);
  expect(decodeIndex(values.get(indexKey)!).cities.ntpc).toEqual(old.cities.ntpc);
  expect(writes).toEqual([...Object.keys(old.cities.taipei!.districts).map(d => shardKey('taipei', new Date('2026-10-31T00:00:00Z').getTime().toString(36), d)), indexKey]);
  expect(decodeIndex(values.get(indexKey)!).cities.taipei!.updatedAt).toBe(old.cities.taipei!.updatedAt);
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

it('publishes all KV shards before the index even when unchanged', async () => {
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
    const minimum = Object.fromEntries(['ntpc','taipei','taichung','tainan','kaohsiung'].map(c => [c, 1])) as Record<City, number>;
    const options = { cities: ['ntpc'] as City[], minimum, fetch: async () => fixture('ntpc'), now: () => new Date('2026-10-30T00:00:00Z') };
    expect(await collectGarbage(store, options)).toBe(0);
    expect(writes.length).toBeGreaterThan(1); expect(writes.at(-1)).toBe(indexKey);
    expect(writes.slice(0, -1).every(k => k.startsWith(`garbage:v2:ntpc:${new Date('2026-10-30T00:00:00Z').getTime().toString(36)}:`))).toBe(true);
    const firstWrites = [...writes];
    const previous = decodeIndex(values.get(indexKey)!).cities.ntpc!.updatedAt;
    writes.length = 0;
    expect(await collectGarbage(store, options)).toBe(0);
    expect(writes).toEqual(firstWrites);
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
  const minimum = { ntpc: 1, taipei: 1, taichung: 1, tainan: 1, kaohsiung: 1 };
  const options = { cities: ['ntpc'] as City[], minimum, fetch: async () => fixture('ntpc') };
  expect(await collectGarbage(store, { ...options, now: () => new Date('2026-10-30T00:00:00Z') })).toBe(0);
  const old = decodeIndex(values.get(indexKey)!).cities.ntpc!;
  const oldShards = Object.keys(old.districts).map(d => values.get(shardKey('ntpc', old.gen, d)));
  expect(oldShards.length).toBeGreaterThan(1);
  fail = true;
  expect(await collectGarbage(store, { ...options, now: () => new Date('2026-10-31T00:00:00Z') })).toBe(1);
  expect(decodeIndex(values.get(indexKey)!).cities.ntpc).toEqual(old);
  expect(Object.keys(old.districts).map(d => values.get(shardKey('ntpc', old.gen, d)))).toEqual(oldShards);
});

it('rejects invalid generation identifiers', () => {
  for (const gen of ['', 'ABC', 'a:b', 'a'.repeat(17)]) {
    expect(() => decodeIndex(JSON.stringify({ v: 2, generatedAt: '2026-10-30T00:00:00Z', cities: { ntpc: { gen, fetchedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', stops: 0, districts: {} } } }))).toThrow();
  }
});
