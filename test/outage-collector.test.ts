import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { collectOutages, directoryStore, kvStore, main, type Store } from '../scripts/publish-outages.js';
import { decodeIndex, indexKey, shardKey, type Source } from '../src/core/outage/model.js';
import { fetchSource, urls } from '../src/outage/source.js';
import { localOutageStore } from '../src/outage/store.js';
import { createOutageService } from '../src/core/outage/service.js';
import { taiwaterEmptyReason } from '../src/core/outage/normalize.js';
import { fixture, zip } from './outage-fixtures.js';
const now = () => new Date('2026-11-01T00:00:00Z');
const mockSources = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const source = (Object.keys(urls) as Source[]).find(s => urls[s] === String(input));
  if (!source) throw Error('unexpected request');
  return source === 'taipower' ? new Response(Buffer.from(zip())) : new Response(fixture(`${source}.json`), { headers: { 'Content-Type': 'application/octet-stream' } });
});
afterEach(() => { vi.restoreAllMocks(); });
it('runs --out with mocked official fetches and serves those files through local stdio storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outage-')); const fetch = mockSources();
  try {
    expect(await main(['--out', dir], {})).toBe(0); expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readdir(dir)).toContain('outage_index_v1.json');
    const disk = directoryStore(dir), index = decodeIndex((await disk.get(indexKey))!); expect(Object.values(index.sources).every(s => s.ok)).toBe(true);
    const store = localOutageStore(dir); fetch.mockClear();
    const reply = await createOutageService(store, now).schedule({ city: '台北', district: '信義區', type: 'power', start_date: '2026-11-05', end_date: '2026-11-06' });
    expect(reply.text).toContain('松仁路'); expect(reply.text).toContain('11/06（五）00:49'); expect(fetch).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('fetches sources concurrently, writes only changed shards, and publishes the heartbeat last', async () => {
  const values = new Map<string, string>(), writes: string[] = [], started: Source[] = [], ttls = new Map<string, number | undefined>();
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v, _at, ttl) => { values.set(k, v); writes.push(k); ttls.set(k, ttl); } };
  mockSources(); const fetch = async (s: Source) => { started.push(s); await Promise.resolve(); expect(started).toHaveLength(3); return fetchSource(s); };
  expect(await collectOutages(store, { fetch, now })).toBe(0); expect(writes.at(-1)).toBe(indexKey); expect(writes.length).toBeGreaterThan(1);
  const first = decodeIndex(values.get(indexKey)!); expect(first.sources.taipower!.dropped).toBeGreaterThan(0); writes.length = 0;
  for (const [source, info] of Object.entries(first.sources)) for (const [county, entry] of Object.entries(info.counties)) {
    const key = shardKey(source as Source, county, entry.sha); expect(key).toBe(`outage:v1:${source}:${county}:${entry.sha.slice(0, 12)}`); expect(values.has(key)).toBe(true); expect(ttls.get(key)).toBe(8 * 86400); expect(entry.writtenAt).toBe(now().toISOString());
  }
  expect(ttls.get(indexKey)).toBeUndefined();
  expect(await collectOutages(store, { now: () => new Date('2026-11-01T06:00:00Z') })).toBe(0); expect(writes).toEqual([indexKey]);
  const second = decodeIndex(values.get(indexKey)!); expect(second.sources.taipower!.counties).toEqual(first.sources.taipower!.counties); expect(second.sources.taipower!.lastSuccessAt).not.toBe(first.sources.taipower!.lastSuccessAt);
  writes.length = 0;
  expect(await collectOutages(store, { now, fetch: async s => { if (s === 'taipower') throw Error('temporarily down'); return fetchSource(s); } })).toBe(1);
  const failed = decodeIndex(values.get(indexKey)!); expect(failed.sources.taipower).toMatchObject({ ok: false, counties: second.sources.taipower!.counties, lastSuccessAt: second.sources.taipower!.lastSuccessAt }); expect(writes).toEqual([indexKey]);
  writes.length = 0;
  expect(await collectOutages(store, { now, fetch: async s => s === 'taipeiwater' ? { items: [], dropped: 0, rows: 0 } : fetchSource(s) })).toBe(0);
  expect(decodeIndex(values.get(indexKey)!).sources.taipeiwater!.counties).toEqual({}); expect(values.has(shardKey('taipeiwater', '臺北市', first.sources.taipeiwater!.counties['臺北市'].sha))).toBe(true); expect(writes).toEqual([indexKey]);
});
it('renews unchanged shards only after three days and refreshes entries missing writtenAt', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => { values.set(k, v); writes.push(k); } }; mockSources();
  expect(await collectOutages(store, { now })).toBe(0); const keys = [...writes]; writes.length = 0;
  expect(await collectOutages(store, { now: () => new Date('2026-11-04T00:00:00Z') })).toBe(0); expect(writes).toEqual([indexKey]); writes.length = 0;
  const renewed = '2026-11-04T00:00:01.000Z'; expect(await collectOutages(store, { now: () => new Date(renewed) })).toBe(0); expect(writes).toEqual(keys);
  const index = decodeIndex(values.get(indexKey)!);
  for (const info of Object.values(index.sources)) for (const entry of Object.values(info.counties)) expect(entry.writtenAt).toBe(renewed);
  const entry = index.sources.taipower!.counties['臺北市']; delete entry.writtenAt; values.set(indexKey, JSON.stringify(index)); writes.length = 0;
  expect(await collectOutages(store, { now: () => new Date(renewed) })).toBe(0); expect(writes).toEqual([shardKey('taipower', '臺北市', entry.sha), indexKey]);
});
it.each(['shard', 'index'])('keeps every previous shard readable after a partial %s write failure', async failure => {
  const values = new Map<string, string>(); let failing = false, shards = 0;
  const store: Store = { get: async k => values.get(k) ?? null, put: async (k, v) => {
    if (failing && (failure === 'index' ? k === indexKey : k.startsWith('outage:v1:taipeiwater:') && ++shards === 2)) throw Error('write failed');
    values.set(k, v);
  } }; mockSources();
  expect(await collectOutages(store, { now })).toBe(0); const before = new Map(values), old = decodeIndex(values.get(indexKey)!); failing = true;
  expect(await collectOutages(store, { now, fetch: async source => { const data = await fetchSource(source); return source === 'taipeiwater' ? { ...data, items: data.items.map(item => ({ ...item, r: 'changed reason' })) } : data; } })).toBe(1);
  for (const [source, info] of Object.entries(old.sources)) for (const [county, entry] of Object.entries(info.counties)) { const key = shardKey(source as Source, county, entry.sha); expect(values.get(key)).toBe(before.get(key)); }
  expect([...values.keys()].some(key => !before.has(key))).toBe(true);
  if (failure === 'index') expect(values.get(indexKey)).toBe(before.get(indexKey));
  else expect(decodeIndex(values.get(indexKey)!).sources.taipeiwater).toMatchObject({ ok: false, counties: old.sources.taipeiwater!.counties, lastSuccessAt: old.sources.taipeiwater!.lastSuccessAt });
});
it('treats empty Taiwan Water, bad JSON, HTTP failure, and short power datasets as unavailable', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]'));
  await expect(fetchSource('taiwater')).rejects.toThrow('空清單'); expect((await fetchSource('taipeiwater')).items).toEqual([]);
  fetch.mockResolvedValue(new Response('{}')); await expect(fetchSource('taiwater')).rejects.toThrow('格式錯誤');
  fetch.mockResolvedValue(new Response('bad')); await expect(fetchSource('taipeiwater')).rejects.toThrow('JSON');
  fetch.mockResolvedValue(new Response(null, { status: 503 })); await expect(fetchSource('taipeiwater')).rejects.toThrow('503');
  fetch.mockResolvedValue(new Response(Buffer.from(zip([['101.csv', '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)\n', 0]])))); await expect(fetchSource('taipower')).rejects.toThrow('筆數不足');
});
it('uses TTL only for shard KV REST writes and redacts failed index reads', async () => {
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer private-token');
    if (init!.method === 'PUT') { expect(new URL(String(_url)).searchParams.get('expiration_ttl')).toBe(String(_url).includes(encodeURIComponent(indexKey)) ? null : '691200'); expect((init!.body as FormData).get('value')).toBe('payload'); return Response.json({ success: true }); }
    return new Response(null, { status: 404 });
  });
  const store = kvStore({ CLOUDFLARE_ACCOUNT_ID: 'a', KV_NAMESPACE_ID: 'n', CLOUDFLARE_KV_WRITE_TOKEN: 'private-token' });
  expect(await store.get(indexKey)).toBeNull(); await store.put(indexKey, 'payload', now().toISOString());
  await store.put(shardKey('taipower', '臺北市', 'a'.repeat(64)), 'payload', now().toISOString(), 8 * 86400);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {}); mock.mockRejectedValue(Error('private-token https://user:pass@example.test/x'));
  expect(await collectOutages(store, { token: 'private-token' })).toBe(1); expect(JSON.stringify(error.mock.calls)).not.toContain('private-token'); expect(JSON.stringify(error.mock.calls)).not.toContain('user:pass');
  expect(await main(['--bad'], {})).toBe(2); expect(await main([], {})).toBe(2);
});
it('publishes healthy sources even when one source is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outage-empty-')); const fetch = mockSources(); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input) === urls.taiwater ? new Response('[]') : original(input, init));
  try { expect(await main(['--out', dir], {})).toBe(1); const index = decodeIndex((await directoryStore(dir).get(indexKey))!); expect(index.sources.taiwater).toMatchObject({ ok: false, reason: expect.stringContaining('空清單'), counties: {} }); expect(index.sources.taipower!.ok).toBe(true); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
it('retains Taiwan Water snapshots through an empty export and recovers on the next non-empty export', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  const store: Store = { get: async key => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); writes.push(key); } };
  const fetch = mockSources(), original = fetch.getMockImplementation()!;
  expect(await collectOutages(store, { now })).toBe(0);
  const before = decodeIndex(values.get(indexKey)!).sources.taiwater!; writes.length = 0;
  fetch.mockImplementation(async (input, init) => String(input) === urls.taiwater ? new Response('[]') : original(input, init));
  const failedAt = '2026-11-03T00:00:00.000Z';
  expect(await collectOutages(store, { now: () => new Date(failedAt) })).toBe(1);
  const failed = decodeIndex(values.get(indexKey)!).sources.taiwater!;
  expect(failed).toMatchObject({ ok: false, reason: taiwaterEmptyReason, fetchedAt: failedAt, lastSuccessAt: before.lastSuccessAt, counties: before.counties });
  expect(writes.some(key => key.startsWith('outage:v1:taiwater:'))).toBe(false);
  const snapshot = { index: async () => decodeIndex(values.get(indexKey)!), shard: async (source: Source, county: string, sha: string) => JSON.parse(values.get(shardKey(source, county, sha))!) };
  const query = { city: '桃園市', type: 'water' as const };
  const oldText = (await createOutageService(snapshot, () => new Date(failedAt)).schedule(query)).text;
  expect(oldText).toContain('桃園區中正路'); expect(oldText).toContain('台水官方開放資料目前是空的'); expect(oldText).toContain('資料可能過期');
  fetch.mockImplementation(original);
  const recoveredAt = '2026-11-03T01:00:00.000Z';
  expect(await collectOutages(store, { now: () => new Date(recoveredAt) })).toBe(0);
  expect(decodeIndex(values.get(indexKey)!).sources.taiwater).toMatchObject({ ok: true, lastSuccessAt: recoveredAt });
  const recovered = (await createOutageService(snapshot, () => new Date(recoveredAt)).schedule(query)).text;
  expect(recovered).toContain('桃園區中正路'); expect(recovered).not.toContain('台水官方開放資料目前是空的');
});
it('reports an empty live Taiwan Water export in the stdio reply', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'));
  const text = (await createOutageService(localOutageStore(), now).schedule({ city: '新竹市', district: '東區', type: 'water' })).text;
  expect(text).toContain('台水官方開放資料目前是空的，結果可能不完整，請至 https://web.water.gov.tw/wateroff/ 自行查詢。');
  expect(text).not.toContain('官方公告中查無');
});
it('caches live stdio source collection for twelve hours', async () => {
  const fetch = mockSources(), store = localOutageStore(); expect((await store.index(['taipower']))!.sources.taipower!.dropped).toBeGreaterThan(0); await store.shard('taipower', '臺北市', '0'.repeat(64)); await store.index(['taipower']); expect(fetch).toHaveBeenCalledOnce();
});
it('retries failed live fetches immediately and caches the recovered source', async () => {
  const fetch = mockSources(), store = localOutageStore(); fetch.mockRejectedValueOnce(Error('temporarily down'));
  expect((await store.index(['taipower']))!.sources.taipower!.ok).toBe(false);
  expect((await store.index(['taipower']))!.sources.taipower!.ok).toBe(true);
  await store.shard('taipower', '臺北市', '0'.repeat(64)); await store.index(['taipower']); expect(fetch).toHaveBeenCalledTimes(2);
});
