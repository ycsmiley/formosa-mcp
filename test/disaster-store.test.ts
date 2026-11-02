import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { localDisasterStore } from '../src/disaster/store.js';
import { createDisasterService } from '../src/core/disaster/service.js';
import { indexKey, shardKey, official, feedUrls } from '../src/core/disaster/model.js';
import { fetchText } from '../src/core/disaster/http.js';
import { directoryStore, kvStore } from '../scripts/snapshot-store.js';
import { main } from '../scripts/publish-disaster.js';
import { filename } from '../src/garbage/store.js';
import { none, at, index, state, emptyJson, emptyAtom } from './disaster-fixtures.js';
// These adapter/cache tests bypass collector sleeps; pacing is covered by collector tests.
vi.mock('../src/core/disaster/collect.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/disaster/collect.js')>();
  return { ...actual, collectDisaster: (options: import('../src/core/disaster/collect.js').Options) => actual.collectDisaster({ ...options, sleep: async () => {} }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const mockFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(String(input) === official.dgpa ? none : String(input) === feedUrls[0] ? emptyJson(new Date().toISOString()) : emptyAtom(new Date().toISOString())));
it('publishes directory snapshots then reads formatted tools without upstream access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disaster-')); vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T09:20:00+08:00')); const fetch = mockFetch();
    expect(await main(['--out', dir], {})).toBe(0); expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([official.dgpa, feedUrls[0], feedUrls[1]]);
    const files = await readdir(dir); expect(files).toContain('disaster_index_gha_v1.json'); expect(files.filter(f => f.startsWith('disaster_v1_'))).toHaveLength(2);
    fetch.mockClear(); const service = createDisasterService(localDisasterStore(dir), () => new Date(at));
    expect((await service.closure({ city: '臺北市' })).text).toContain('官方頁面：「無停班停課訊息。」'); expect((await service.alerts({ city: '臺北市' })).text).toContain('目前沒有臺北市生效中的告警'); expect(fetch).not.toHaveBeenCalled();
    await writeFile(join(dir, filename(indexKey('worker'))), 'invalid'); expect((await localDisasterStore(dir).indexes()).gha?.writer).toBe('gha');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('caches live successes for ten minutes and coalesces readers independently per source', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); const fetch = mockFetch(), store = localDisasterStore();
  await Promise.all([store.indexes(), store.indexes()]); expect(fetch).toHaveBeenCalledTimes(3);
  await store.indexes(); expect(fetch).toHaveBeenCalledTimes(3); vi.setSystemTime(new Date(Date.parse(at) + 10 * 60000 + 1));
  await store.indexes(); expect(fetch).toHaveBeenCalledTimes(6);
  const separate = localDisasterStore(); fetch.mockClear();
  const dgpa = await separate.indexes('dgpa'); expect(Object.keys(dgpa.gha!.sources)).toEqual(['dgpa']); expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([official.dgpa]);
  const ncdr = await separate.indexes('ncdr'); expect(Object.keys(ncdr.gha!.sources)).toEqual(['ncdr']); expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([official.dgpa, feedUrls[0], feedUrls[1]]);
  expect(Object.keys((await separate.indexes()).gha!.sources)).toEqual(['dgpa', 'ncdr']); expect(fetch).toHaveBeenCalledTimes(3);
});
it('allows closure to finish immediately while an independent NCDR refresh is still in flight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
  let release!: (response: Response) => void; let waiting = true;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input) === official.dgpa ? new Response(none) : !waiting ? new Response(emptyAtom()) : new Promise<Response>(resolve => { release = response => { waiting = false; resolve(response); }; }));
  const timeout = vi.spyOn(AbortSignal, 'timeout'), store = localDisasterStore(), ncdr = store.indexes('ncdr');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  try {
    const started = performance.now();
    const closure = await createDisasterService(store, () => new Date(at)).closure({ city: '臺北市' });
    expect(closure.text).toContain('官方頁面：「無停班停課訊息。」'); expect(performance.now() - started).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalledTimes(2); expect(timeout.mock.calls).toEqual([[12000], [12000]]);
  } finally {
    release(new Response(emptyJson())); await ncdr;
  }
  expect((await store.indexes('dgpa')).gha!.sources.dgpa!.ok).toBe(true);
});
it('negative-caches an initial DGPA failure for two minutes with its reason, then recovers', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('DGPA timeout')), store = localDisasterStore();
  const failed = await store.indexes('dgpa'); expect(failed.gha!.sources.dgpa).toMatchObject({ ok: false, reason: 'DGPA timeout' });
  const service = createDisasterService(store, () => new Date(at));
  expect((await service.closure({ city: '臺北市' })).text).toContain('DGPA timeout');
  await vi.advanceTimersByTimeAsync(2 * 60000 - 1); await store.indexes('dgpa'); expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(new Response(none)); await vi.advanceTimersByTimeAsync(1);
  expect((await store.indexes('dgpa')).gha!.sources.dgpa!.ok).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(['dgpa', 'ncdr'] as const)('negative-caches a failed %s refresh while preserving older good data and its failure reason', async source => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); const fetch = mockFetch(), store = localDisasterStore();
  const good = (await store.indexes(source)).gha!.sources[source]!;
  await vi.advanceTimersByTimeAsync(10 * 60000); fetch.mockRejectedValue(Error('upstream timeout'));
  const refresh = store.indexes(source); const failed = (await refresh).gha!.sources[source]!;
  expect(failed).toMatchObject({ ok: false, reason: 'upstream timeout', sha: good.sha, lastSuccessAt: good.lastSuccessAt });
  expect(await store.shard(source, good.sha!)).not.toBeNull();
  const service = createDisasterService(store), result = await (source === 'dgpa' ? service.closure({ city: '臺北市' }) : service.alerts({ city: '臺北市' }));
  expect(result.text).toContain('最近一次抓取失敗');
  const calls = fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(2 * 60000 - 1); await store.indexes(source); expect(fetch).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1); const retry = store.indexes(source); await retry; expect(fetch.mock.calls.length).toBeGreaterThan(calls);
});
it('reuses directory and TTL-aware KV adapters and validates script options without fetching', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
  expect(await main(['--bad'], {})).toBe(2); expect(await main([], {})).toBe(2); expect(fetch).not.toHaveBeenCalled();
  const store = kvStore({ CLOUDFLARE_ACCOUNT_ID: 'account', KV_NAMESPACE_ID: 'namespace', CLOUDFLARE_KV_WRITE_TOKEN: 'test-token' });
  await store.put('disaster:v1:ncdr:abcdefabcdef', '[]', at, 8 * 86400); expect(String(fetch.mock.calls[0][0])).toContain('?expiration_ttl=691200');
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'PUT', redirect: 'manual', headers: { Authorization: 'Bearer test-token' } });
});
it('caps streamed responses at 1MB and follows redirects with a timeout', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
  await expect(fetchText(official.dgpa, 15000)).rejects.toThrow('大小上限'); expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'follow' });
  fetch.mockResolvedValue(new Response('UTF-8 臺灣')); expect((await fetchText(official.dgpa, 15000)).text).toBe('UTF-8 臺灣');
});
it('directory adapter preserves heartbeat-last ordering and never expires local content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disaster-store-'));
  try { const store = directoryStore(dir); await store.put(shardKey('ncdr', 'a'.repeat(12)), '[]', at, 1); await store.put(indexKey('gha'), JSON.stringify(index({ ncdr: state() }, 'gha')), at); expect(await store.get(shardKey('ncdr', 'a'.repeat(12)))).toBe('[]'); } finally { await rm(dir, { recursive: true, force: true }); }
});

it('surfaces corrupt directory indexes instead of treating them as absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disaster-corrupt-'));
  try {
    const store = directoryStore(dir);
    await store.put('disaster:index:worker:v1', '{broken', at);
    const local = localDisasterStore(dir);
    expect((await local.indexes()).error).toBe(true);
    const service = createDisasterService(local, () => new Date(at));
    for (const tool of [service.closure, service.alerts]) expect((await tool({ city: '臺北市' })).text).toContain('索引無法解讀');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
