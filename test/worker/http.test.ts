import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import worker, { keys, cronJobs, type Env } from '../../src/worker/index.js';
import { buildInvoiceSnapshot, buildStockSnapshot, encodeQuotesSnapshot, decodeQuotesSnapshot, encodeSnapshot, decodeSnapshot } from '../../src/core/snapshot.js';
import { stockUrls } from '../../src/core/stock/source.js';
import xml from '../fixtures/invoice.xml?raw';
import config from '../../wrangler.jsonc?raw';
import tq from '../fixtures/stock/twse_quotes.json';
import tr from '../fixtures/stock/twse_ratios.json';
import td from '../fixtures/stock/twse_div.json';
import pq from '../fixtures/stock/tpex_quotes.json';
import pr from '../fixtures/stock/tpex_ratios.json';
import pd from '../fixtures/stock/tpex_div.json';
const bindings = env as unknown as Env;
const fixtures = [tq, tr, td, pq, pr, pd];
const fixtureFetch = async (url: string) => fixtures[Object.values(stockUrls).indexOf(url)];
const allKeys = Object.values(keys);
const marketKeys = (market: 'twse' | 'tpex') => [keys[`${market}Quotes`], keys[`${market}Dividends`]];
const seed = async () => {
  const invoice = await buildInvoiceSnapshot(async () => xml);
  await bindings.SNAPSHOTS.put(keys.invoice, encodeSnapshot({ ...invoice, updatedAt: '' }), { metadata: { updatedAt: invoice.updatedAt } });
  for (const market of ['twse', 'tpex'] as const) {
    const stock = await buildStockSnapshot(market, fixtureFetch);
    const options = { metadata: { updatedAt: '2026-10-26T00:00:00.000Z' } };
    await bindings.SNAPSHOTS.put(keys[`${market}Quotes`], encodeQuotesSnapshot({ ...stock.quotes!, updatedAt: '' }), options);
    await bindings.SNAPSHOTS.put(keys[`${market}Dividends`], encodeSnapshot({ ...stock.dividends!, updatedAt: '' }), options);
  }
};
const mockUpstream = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const url = String(input); return url.includes('invoice.xml') ? new Response(xml) : Response.json(await fixtureFetch(url));
});
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
  await seed();
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
  for (const key of allKeys) await bindings.SNAPSHOTS.delete(key);
  for (const name of ['stock_quote', 'stock_dividends', 'invoice_get_winning_numbers', 'invoice_check']) {
    expect((await rpc('tools/call', { name, arguments: { query: '2330', number: '54348835' } })).content[0].text).toBe('資料更新中，請稍後再試');
  }
  await bindings.SNAPSHOTS.put(keys.twseQuotes, 'private error');
  expect((await rpc('tools/call', { name: 'stock_quote', arguments: { query: '2330' } })).content[0].text).toBe('暫時無法取得資料，請稍後再試。');
});
it('matches the five configured cron strings', () => {
  expect(JSON.parse(config.replace(/\/\/[^\n]*/g, '')).triggers.crons).toEqual(Object.keys(cronJobs));
});
it.each(['twse', 'tpex'] as const)('serves a missing %s market with partial warnings and no upstream fetch', async missing => {
  await seed();
  for (const key of marketKeys(missing)) await bindings.SNAPSHOTS.delete(key);
  const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  try {
    for (const [name, args] of [['stock_quote', { query: missing === 'twse' ? '6488' : '2330' }], ['stock_dividends', {}]] as const) {
      const result = await rpc('tools/call', { name, arguments: args });
      expect(result.content[0].text).toContain(missing === 'twse' ? '（證交所資料暫時取不到）' : '（櫃買中心資料暫時取不到）');
      expect(result.isError).not.toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
const schedules = Object.entries(cronJobs).flatMap(([cron, job]) => job === 'weekend'
  ? [0, 30].map(minute => ({ cron, job: minute < 30 ? 'twse' : 'tpex', scheduledTime: Date.UTC(2026, 9, 31, 0, minute) }))
  : [{ cron, job, scheduledTime: Date.UTC(2026, 9, 27) }]);
it.each(schedules)('cron $cron at $scheduledTime fetches only $job', async ({ cron, job, scheduledTime }) => {
  for (const key of allKeys) await bindings.SNAPSHOTS.delete(key);
  const spy = mockUpstream();
  try {
    await worker.scheduled(createScheduledController({ cron, scheduledTime }), bindings, createExecutionContext());
    const expected = job === 'invoice' ? ['https://invoice.etax.nat.gov.tw/invoice.xml'] : Object.entries(stockUrls).filter(([key]) => key.startsWith(job)).map(([, url]) => url);
    expect(spy.mock.calls.map(([url]) => String(url)).sort()).toEqual(expected.sort());
    const written = job === 'invoice' ? [keys.invoice] : marketKeys(job as 'twse' | 'tpex');
    for (const key of allKeys) expect(await bindings.SNAPSHOTS.get(key) !== null).toBe(written.includes(key));
  } finally { spy.mockRestore(); }
});
it('unknown local cron bootstraps all feeds, roundtrips payloads and skips all unchanged puts', async () => {
  for (const key of allKeys) await bindings.SNAPSHOTS.delete(key);
  const spy = mockUpstream();
  try {
    await worker.scheduled(createScheduledController({ cron: '' }), bindings, createExecutionContext());
    expect(spy).toHaveBeenCalledTimes(7);
    const before = await Promise.all(allKeys.map(key => bindings.SNAPSHOTS.getWithMetadata<{ updatedAt: string }>(key)));
    for (const [i, { value, metadata }] of before.entries()) {
      const quotes = allKeys[i] === keys.twseQuotes || allKeys[i] === keys.tpexQuotes;
      expect(quotes ? encodeQuotesSnapshot(decodeQuotesSnapshot(value!)) : encodeSnapshot(decodeSnapshot<object>(value!))).toBe(value);
      expect(Number.isFinite(Date.parse(metadata!.updatedAt))).toBe(true);
    }
    const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
    try {
      await worker.scheduled(createScheduledController({ cron: '' }), bindings, createExecutionContext());
      expect(put).not.toHaveBeenCalled();
      expect(await Promise.all(allKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
    } finally { put.mockRestore(); }
  } finally { spy.mockRestore(); }
});
it.each((['twse', 'tpex'] as const).flatMap(market => ['quotes', 'ratios', 'div'].map(failed => ({ market, failed }))))('keeps previous $market $failed data and still writes the independent snapshot', async ({ market, failed }) => {
  await seed();
  const [quoteKey, divKey] = marketKeys(market);
  const retainedKey = failed === 'div' ? divKey : quoteKey, freshKey = failed === 'div' ? quoteKey : divKey;
  const before = await bindings.SNAPSHOTS.getWithMetadata(retainedKey);
  await bindings.SNAPSHOTS.delete(freshKey);
  const spy = mockUpstream();
  spy.mockImplementation(async input => {
    const url = String(input);
    if (url === stockUrls[`${market}-${failed}` as keyof typeof stockUrls]) return new Response('private details', { status: 503 });
    return Response.json(await fixtureFetch(url));
  });
  try {
    const cron = Object.entries(cronJobs).find(([, job]) => job === market)![0];
    await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
    expect(await bindings.SNAPSHOTS.getWithMetadata(retainedKey)).toEqual(before);
    expect(await bindings.SNAPSHOTS.get(freshKey)).not.toBeNull();
  } finally { spy.mockRestore(); }
});
it.each(['fetch', 'parse'])('writes nothing on market %s failure and updates metadata only on a data change', async failure => {
  await seed();
  const before = await Promise.all(allKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)));
  const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private details'));
  if (failure === 'parse') spy.mockImplementation(async () => Response.json({ private: 'invalid upstream shape' }));
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  try {
    const cron = Object.entries(cronJobs).find(([, job]) => job === 'twse')![0];
    await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
    expect(put).not.toHaveBeenCalled();
    expect(await Promise.all(allKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
    spy.mockImplementation(async input => {
      const data = await fixtureFetch(String(input));
      return Response.json(String(input) === stockUrls['twse-quotes'] ? tq.map(row => ({ ...row, ClosingPrice: '2500' })) : data);
    });
    await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
    expect(put).toHaveBeenCalledTimes(1);
    const next = await bindings.SNAPSHOTS.getWithMetadata<{ updatedAt: string }>(keys.twseQuotes);
    expect(next.metadata!.updatedAt > '2026-10-26T00:00:00.000Z').toBe(true);
    expect(next.value).not.toBe(before[allKeys.indexOf(keys.twseQuotes)].value);
  } finally { spy.mockRestore(); put.mockRestore(); }
});
