import { env, createExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../src/worker/index.js';
import cpc from '../fixtures/fuel/cpc-mainprodlistprice-2026-11-16.json';
import { fuelKey } from '../../src/core/fuel/model.js';
import { parseFuel } from '../../src/core/fuel/parse.js';
import { fuelUrl } from '../../src/core/fuel/source.js';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it.each(['fresh', 'stale', 'missing', 'corrupt'])('serves %s fuel KV without ever fetching CPC or writing KV', async state => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-17T01:18:00Z'));
  const time = state === 'fresh' ? new Date().toISOString() : '2000-01-01T00:00:00.000Z';
  const get = vi.fn(async (key: string) => { expect(key).toBe(fuelKey); return state === 'missing' ? null : state === 'corrupt' ? '{}' : JSON.stringify({ v: 1, items: parseFuel(cpc), changedAt: '2000-01-01T00:00:00.000Z', checkedAt: time }); }), put = vi.fn();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('Worker must NEVER fetch CPC'); });
  const bindings = { ...env, SNAPSHOTS: { get, put } } as unknown as Env;
  const response = await worker.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '192.0.2.43' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fuel_price', arguments: { product: '95' } } }) }), bindings, createExecutionContext());
  expect(response.status).toBe(200); const body = await response.text(), line = body.split('\n').find(l => l.startsWith('data:')), result = JSON.parse(line ? line.slice(5) : body).result, text = result.content[0].text;
  expect(text).toContain(fuelUrl); expect(text).toContain('不含台塑石化');
  if (['missing', 'corrupt'].includes(state)) { expect(result.isError).toBe(true); expect(text).toContain('中油牌價資料尚未準備好'); }
  else { expect(result.isError).not.toBe(true); expect(text).toContain('95無鉛汽油：32.7 元/公升'); expect(text.includes('可能不是最新')).toBe(state === 'stale'); }
  expect(fetch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1);
});
