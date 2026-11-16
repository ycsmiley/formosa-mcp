import { env, createExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../src/worker/index.js';
import { fixtureData, now } from '../output-contract-fixtures.js';
import { contractSuite, textOf } from '../output-contract-helper.js';
const fresh = fixtureData(), stale = fixtureData(true);
let sequence = 0;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function rpc(method: string, params?: object, old = false, name?: string, values?: Map<string, string>) {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Stock fixture dates stop in Oct/early Nov: Nov 20 is past the existing
  // weekday thresholds (stock/format.ts:24-27, stock/market.ts:85-94).
  vi.setSystemTime(new Date(old && name === 'fuel_price' ? '2026-11-04T01:15:00Z' : old && name?.startsWith('invoice_') ? '2026-11-29T01:15:00Z' : old && name?.startsWith('stock_') ? '2026-11-20T11:00:00Z' : now));
  const data = await (old ? stale : fresh), kv = env.SNAPSHOTS as KVNamespace;
  const listed = await kv.list(); await Promise.all(listed.keys.map(k => kv.delete(k.name)));
  for (const [key, value] of values ?? data.values) await kv.put(key, value);
  // Successful gateway fixture for fresh live; stale live intentionally exercises
  // the persisted timetable fallback with no project key.
  const bindings = { ...env, DISASTER_ENABLED: 'true',
    TDX_CLIENT_ID: old || (params as any)?.arguments?.train_no === '149' ? undefined : 'fixture', TDX_CLIENT_SECRET: old || (params as any)?.arguments?.train_no === '149' ? undefined : 'fixture',
    TDX_GATEWAY: { idFromName: () => 'fixture', get: () => ({ live: async () => ({ ok: true, data: data.liveTrain, fetchedAt: now }) }) },
  } as unknown as Env;
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('contract fixtures must never fetch upstream'));
  try {
    const response = await worker.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': `192.0.2.${++sequence}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    }), bindings, createExecutionContext());
    if (response.status !== 200) throw Error(`Worker RPC HTTP ${response.status}`);
    const text = await response.text(), line = text.split('\n').find(s => s.startsWith('data:'));
    const parsed = JSON.parse(line ? line.slice(5) : text);
    if (parsed.error) throw Error(`Worker RPC error ${parsed.error.code}`);
    if (http.mock.calls.length) throw Error('Worker contract unexpectedly fetched upstream');
    return parsed.result;
  } finally { http.mockRestore(); vi.useRealTimers(); }
}
// tools/list is the Worker HTTP equivalent of Client.listTools(), using the
// existing worker.fetch RPC harness (not a duplicate registration).
async function listTools(): Promise<string[]> { return (await rpc('tools/list')).tools.map((t: { name: string }) => t.name); }
contractSuite('worker', { sourceFailure: () => rpc('tools/call', { name: 'fuel_price', arguments: {} }, false, 'fuel_price', new Map()), listTools, call: (name, args, old) => rpc('tools/call', { name, arguments: args }, old, name) });
it.each([{}, { query: '2330' }])('empty Worker dividends label the content-change date rather than the query date (%j)', async args => {
  const text = textOf(await rpc('tools/call', { name: 'stock_dividends', arguments: args }, true, 'stock_dividends'));
  expect(text).toContain('\n資料更新：115年10月23日\n');
  expect(text).not.toContain('資料更新：115年11月20日');
  expect(text).not.toMatch(/^- /m);
});

// Content-change clocks may be months old while successful checks are recent.
// Exercise the real Worker reader with separate market heartbeats and legacy KV.
it.each(['both', 'twse', 'tpex'] as const)('dividend freshness follows successful %s checks independently of unchanged content', async market => {
  const values = new Map((await stale).values), checkedAt = '2026-11-20T11:00:00Z';
  values.set('stock:collect:dividends:twse:v1', JSON.stringify({ v: 1, lastSuccessAt: market === 'tpex' ? '2000-01-01T00:00:00Z' : checkedAt }));
  values.set('stock:collect:tpex:v1', JSON.stringify({ v: 1, lastSuccessAt: '2000-01-01T00:00:00Z', dataDate: '2026-10-29', dividendsLastSuccessAt: market === 'twse' ? '2000-01-01T00:00:00Z' : checkedAt }));
  const text = textOf(await rpc('tools/call', { name: 'stock_dividends', arguments: {} }, true, 'stock_dividends', values));
  expect(text).toContain('資料更新：115年10月23日');
  expect(text.includes('上市除權息')).toBe(market === 'tpex');
  expect(text.includes('上櫃除權息')).toBe(market === 'twse');
  expect(text.includes('可能不是最新')).toBe(market !== 'both');
});
it('legacy dividend KV without heartbeat falls back to its content timestamp', async () => {
  const values = new Map((await stale).values);
  values.delete('stock:collect:tpex:v1');
  const text = textOf(await rpc('tools/call', { name: 'stock_dividends', arguments: {} }, true, 'stock_dividends', values));
  expect(text).toContain('上市除權息'); expect(text).toContain('上櫃除權息');
});
