import { env, createExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../src/worker/index.js';
import { fixtureData, now } from '../output-contract-fixtures.js';
import { contractSuite, textOf } from '../output-contract-helper.js';
const fresh = fixtureData(), stale = fixtureData(true);
let sequence = 0;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function rpc(method: string, params?: object, old = false, name?: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Stock fixture dates stop in Oct/early Nov: Nov 20 is past the existing
  // weekday thresholds (stock/format.ts:24-27, stock/market.ts:85-94).
  vi.setSystemTime(new Date(old && name?.startsWith('stock_') ? '2026-11-20T11:00:00Z' : now));
  const data = await (old ? stale : fresh), kv = env.SNAPSHOTS as KVNamespace;
  const listed = await kv.list(); await Promise.all(listed.keys.map(k => kv.delete(k.name)));
  for (const [key, value] of data.values) await kv.put(key, value);
  // Successful gateway fixture for fresh live; stale live intentionally exercises
  // the persisted timetable fallback with no project key.
  const bindings = { ...env, DISASTER_ENABLED: 'true',
    TDX_CLIENT_ID: old ? undefined : 'fixture', TDX_CLIENT_SECRET: old ? undefined : 'fixture',
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
contractSuite('worker', { listTools, call: (name, args, old) => rpc('tools/call', { name, arguments: args }, old, name) });
it.each([{}, { query: '2330' }])('empty Worker dividends show the snapshot date rather than the query date (%j)', async args => {
  const text = textOf(await rpc('tools/call', { name: 'stock_dividends', arguments: args }, true, 'stock_dividends'));
  expect(text).toContain('\n資料日期：115年10月23日\n');
  expect(text).not.toContain('資料日期：115年11月20日');
  expect(text).not.toMatch(/^- /m);
});
