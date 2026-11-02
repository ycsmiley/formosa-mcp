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
import { none, at, index, state } from './disaster-fixtures.js';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const mockFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(String(input) === official.dgpa ? none : JSON.stringify({ id: 'test', title: 'NCDR', updated: new Date().toISOString(), entry: [] })));
it('publishes directory snapshots then reads formatted tools without upstream access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disaster-')); vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T09:20:00+08:00')); const fetch = mockFetch();
    expect(await main(['--out', dir], {})).toBe(0); expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([official.dgpa, feedUrls[0]]);
    const files = await readdir(dir); expect(files).toContain('disaster_index_gha_v1.json'); expect(files.filter(f => f.startsWith('disaster_v1_'))).toHaveLength(2);
    fetch.mockClear(); const service = createDisasterService(localDisasterStore(dir), () => new Date(at));
    expect((await service.closure({ city: '臺北市' })).text).toContain('官方頁面：「無停班停課訊息。」'); expect((await service.alerts({ city: '臺北市' })).text).toContain('目前沒有臺北市生效中的告警'); expect(fetch).not.toHaveBeenCalled();
    await writeFile(join(dir, filename(indexKey('worker'))), 'invalid'); expect((await localDisasterStore(dir).indexes()).gha?.writer).toBe('gha');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('caches live successes for ten minutes, coalesces readers and retries failures immediately', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); const fetch = mockFetch(), store = localDisasterStore();
  await Promise.all([store.indexes(), store.indexes()]); expect(fetch).toHaveBeenCalledTimes(2);
  await store.indexes(); expect(fetch).toHaveBeenCalledTimes(2); vi.setSystemTime(new Date(Date.parse(at) + 10 * 60000 + 1));
  await store.indexes(); expect(fetch).toHaveBeenCalledTimes(4);
  // A failed DGPA with a valid empty NCDR feed still retries on the next read.
  const fresh = localDisasterStore(); fetch.mockImplementation(async input => new Response(String(input) === official.dgpa ? 'unrecognized' : JSON.stringify({ id: 'test', title: 'NCDR', updated: new Date().toISOString(), entry: [] })));
  await fresh.indexes(); const before = fetch.mock.calls.length;
  const retry = fresh.indexes(); await vi.advanceTimersByTimeAsync(3100); await retry; expect(fetch.mock.calls.length).toBe(before + 2);
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
