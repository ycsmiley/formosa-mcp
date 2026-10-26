import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import worker, { keys, type Env } from '../../src/worker/index.js';
import { buildInvoiceSnapshot, buildStockSnapshot, encodeSnapshot, decodeSnapshot } from '../../src/core/snapshot.js';
import { stockUrls } from '../../src/core/stock/source.js';
import xml from '../fixtures/invoice.xml?raw';
import tq from '../fixtures/stock/twse_quotes.json';
import tr from '../fixtures/stock/twse_ratios.json';
import td from '../fixtures/stock/twse_div.json';
import pq from '../fixtures/stock/tpex_quotes.json';
import pr from '../fixtures/stock/tpex_ratios.json';
import pd from '../fixtures/stock/tpex_div.json';
const bindings = env as unknown as Env;
const fixtures = [tq, tr, td, pq, pr, pd];
const fixtureFetch = async (url: string) => fixtures[Object.values(stockUrls).indexOf(url)];
let sequence = 0;
const run = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`http://localhost${path}`, init), bindings, createExecutionContext());
const rpc = async (method: string, params = {}, ip = `test-${sequence++}`) => {
  const r = await run('/mcp', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': ip }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await r.text();
  expect(r.status, text).toBe(200);
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(l => l.startsWith('data:'))!.slice(5) : text).result;
};
it('routes, bounds actual bytes and declared lengths, and uses native rate limiting', async () => {
  expect(await (await run('/')).text()).toContain('MCP 端點：/mcp');
  expect((await run('/nope')).status).toBe(404);
  expect((await run('/mcp', { method: 'DELETE' })).status).toBe(405);
  expect((await run('/mcp', { method: 'POST', body: 'x'.repeat(65537) })).status).toBe(413);
  expect((await run('/mcp', { method: 'POST', headers: { 'Content-Length': '65537' }, body: 'x' })).status).toBe(413);
  let response: Response | undefined;
  for (let i = 0; i < 40; i++) { response = await run('/mcp', { headers: { 'CF-Connecting-IP': 'burst' } }); if (response.status === 429) break; }
  expect(response!.status).toBe(429); expect(response!.headers.get('Retry-After')).toBe('60');
});
it('lists exactly four tools and serves seeded snapshots without upstream fetch', async () => {
  const invoice = await buildInvoiceSnapshot(async () => xml), stock = await buildStockSnapshot(fixtureFetch);
  await bindings.SNAPSHOTS.put(keys.invoice, encodeSnapshot(invoice));
  await bindings.SNAPSHOTS.put(keys.quotes, encodeSnapshot(stock.quotes));
  await bindings.SNAPSHOTS.put(keys.dividends, encodeSnapshot(stock.dividends));
  const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  try {
    expect((await rpc('tools/list')).tools.map((t: { name: string }) => t.name).sort()).toEqual(['invoice_check', 'invoice_get_winning_numbers', 'stock_dividends', 'stock_quote']);
    for (const [name, args, expected] of [ ['stock_quote', { query: '2330' }, '台積電'], ['stock_quote', { query: '6488' }, '環球晶'], ['stock_dividends', {}, '近期除權息'], ['invoice_get_winning_numbers', {}, '統一發票中獎號碼'], ['invoice_check', { number: '54348835' }, '頭獎'] ] as const) {
      const result = await rpc('tools/call', { name, arguments: args }); const text = result.content[0].text;
      expect(text).toContain(expected); expect(text).not.toMatch(/undefined|null|NaN|\[object/);
    }
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
it('returns updating for empty KV and hides malformed data errors', async () => {
  for (const key of Object.values(keys)) await bindings.SNAPSHOTS.delete(key);
  for (const name of ['stock_quote', 'stock_dividends', 'invoice_get_winning_numbers', 'invoice_check']) {
    expect((await rpc('tools/call', { name, arguments: { query: '2330', number: '54348835' } })).content[0].text).toBe('資料更新中，請稍後再試');
  }
  await bindings.SNAPSHOTS.put(keys.quotes, 'private error');
  expect((await rpc('tools/call', { name: 'stock_quote', arguments: { query: '2330' } })).content[0].text).toBe('暫時無法取得資料，請稍後再試。');
});
it('scheduled refresh writes compact roundtrippable snapshots and skips unchanged writes', async () => {
  for (const key of Object.values(keys)) await bindings.SNAPSHOTS.delete(key);
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input); return url.includes('invoice.xml') ? new Response(xml) : Response.json(await fixtureFetch(url));
  });
  try {
    await worker.scheduled(createScheduledController({ cron: '' }), bindings, createExecutionContext());
    const before = await Promise.all(Object.values(keys).map(key => bindings.SNAPSHOTS.get(key)));
    for (const raw of before) expect(encodeSnapshot(decodeSnapshot<object>(raw!))).toBe(raw);
    await worker.scheduled(createScheduledController({ cron: '' }), bindings, createExecutionContext());
    expect(await Promise.all(Object.values(keys).map(key => bindings.SNAPSHOTS.get(key)))).toEqual(before);
  } finally { spy.mockRestore(); }
});
