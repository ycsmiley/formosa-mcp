import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { cronJobs, type Env } from '../../src/worker/index.js';
import { indexKey, shardKey, decodeIndex, official, feedUrls } from '../../src/core/disaster/model.js';
import none from '../fixtures/disaster/dgpa-nds-2026-11-02-no-event.html?raw';
import config from '../../wrangler.jsonc?raw';
const bindings = env as unknown as Env, cron = '5,15,25,35,45,55 * * * *';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('configures exactly five cron keys with an independent disaster route', () => {
  const parsed = JSON.parse(config.replace(/\/\/[^\n]*/g, ''));
  expect(parsed.triggers.crons).toHaveLength(5); expect(parsed.triggers.crons).toEqual(Object.keys(cronJobs)); expect(cronJobs[cron]).toBe('disaster');
});
it('runs only disaster on x5, writes shards before its index, and serves formatted text through Worker MCP', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T09:15:00+08:00'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input); if (url === official.dgpa) return new Response(none);
    if (url === feedUrls[0]) return Response.json({ id: 'test', title: 'NCDR', author: { name: 'NCDR' }, updated: new Date().toISOString(), entry: [] });
    if (url === feedUrls[1]) return new Response(`<feed><id>test</id><title>NCDR</title><author><name>NCDR</name></author><updated>${new Date().toISOString()}</updated></feed>`);
    throw Error('unexpected upstream');
  });
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), bindings, createExecutionContext());
  expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([official.dgpa, feedUrls[0], feedUrls[1]]);
  const raw = await bindings.SNAPSHOTS.get(indexKey('worker')); expect(raw).not.toBeNull(); const index = decodeIndex(raw!);
  for (const source of ['dgpa', 'ncdr'] as const) { expect(index.sources[source]?.ok).toBe(true); expect(await bindings.SNAPSHOTS.get(shardKey(source, index.sources[source]!.sha!))).not.toBeNull(); }
  expect(put.mock.calls.at(-1)?.[0]).toBe(indexKey('worker')); expect(put.mock.calls.every(([k]) => k.startsWith('disaster:'))).toBe(true);
  expect(put.mock.calls[0][2]).toMatchObject({ expirationTtl: 8 * 86400 }); fetch.mockClear();
  // The KV adapter accepts source-specific reads for both tools without refreshing upstream.
  for (const name of ['work_school_closure', 'disaster_alerts']) {
    const response = await worker.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '203.0.113.135' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { city: '臺北市' } } }) }), bindings, createExecutionContext());
    const body = await response.text(); expect(response.status).toBe(200);
    const reply = JSON.parse(body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').find(l => l.startsWith('data:'))!.slice(5) : body).result;
    expect(reply.content[0].text).toContain(name === 'work_school_closure' ? '官方頁面：「無停班停課訊息。」' : '目前沒有臺北市生效中的告警');
    expect(reply.content[0].text).toContain(name === 'work_school_closure' ? official.dgpa : official.ncdr); expect(reply.content[0].text).not.toContain('照常');
  }
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['*/10 5-15 25 1,3,5,7,9,11 *', '0,30 * * * MON-FRI'])('does not run disaster for %s', async cron => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 })); vi.spyOn(console, 'warn').mockImplementation(() => {});
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.UTC(2026, 10, 2, 0) }), bindings, createExecutionContext());
  expect(fetch).toHaveBeenCalled(); expect(fetch.mock.calls.some(([u]) => String(u) === official.dgpa || String(u).startsWith(official.ncdr))).toBe(false);
});
it('contains collection exceptions rather than rejecting scheduled', async () => {
  vi.spyOn(bindings.SNAPSHOTS, 'get').mockRejectedValue(Error('https://private.example Bearer secret')); const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), bindings, createExecutionContext())).resolves.toBeUndefined(); expect(log).toHaveBeenCalled(); expect(JSON.stringify(log.mock.calls)).not.toMatch(/private.example|secret/);
});
it('uses the GHA peer source revision to prevent an older Worker publication', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T09:15:00+08:00'));
  const stamp = new Date().toISOString(), sha = 'a'.repeat(12);
  await bindings.SNAPSHOTS.put(indexKey('gha'), JSON.stringify({ v: 1, writer: 'gha', heartbeatAt: stamp, sources: { dgpa: { ok: true, sha, count: 0, writtenAt: stamp, lastSuccessAt: stamp, fetchedAt: stamp, sourceUpdatedAt: stamp } } }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input) === official.dgpa ? new Response(none) : new Response('unavailable', { status: 503 }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), bindings, createExecutionContext());
  const result = decodeIndex((await bindings.SNAPSHOTS.get(indexKey('worker')))!);
  expect(result.sources.dgpa).toMatchObject({ skipped: true, reason: '對方已有較新來源版本' });
  expect(put.mock.calls.some(([key]) => key.startsWith('disaster:v1:dgpa:'))).toBe(false);
});
it('reports corrupt Worker KV indexes through disaster tools', async () => {
  await bindings.SNAPSHOTS.put(indexKey('worker'), '{broken');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('upstream forbidden'));
  for (const name of ['work_school_closure', 'disaster_alerts']) {
    const response = await worker.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '203.0.113.136' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { city: '臺北市' } } }) }), bindings, createExecutionContext());
    const text = await response.text(); expect(text).toContain('索引無法解讀'); expect(text).not.toContain('尚無成功取得的資料');
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('does not send NCDR requests after a delayed scheduled deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T09:16:01+08:00'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input) !== official.dgpa) throw Error('NCDR must not start after deadline');
    return new Response(none);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() - 61000 }), bindings, createExecutionContext());
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([official.dgpa]);
  expect(decodeIndex((await bindings.SNAPSHOTS.get(indexKey('worker')))! ).sources.ncdr?.ok).toBe(false);
});
