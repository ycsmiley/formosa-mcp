import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { keys, metaKeys, cronJobs, type Env } from '../../src/worker/index.js';
import { collectKeys } from '../../src/worker/snapshot-keys.js';
import * as stockSource from '../../src/worker/stock-source.js';
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
const fetchStockFeed = stockSource.fetchStockFeed;
beforeEach(() => {
  vi.spyOn(stockSource, 'fetchStockFeed').mockImplementation((feed, url, validators) => fetchStockFeed(feed, url, validators, { retryDelayMs: 0 }));
});
const feedHeaders = { accept: 'application/json', 'user-agent': 'formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)' };
// Small checked-in samples expanded to exercise the production non-empty guard.
const expand = <T extends object>(rows: T[], count: number, codeKey: string) => Array.from({ length: count }, (_, i) => i < rows.length ? rows[i] : { ...rows[0], [codeKey]: `test-${i}` });
const fixtures = [expand(tq, 100, 'Code'), tr, td, expand(pq, 50, 'SecuritiesCompanyCode'), pr, pd];
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
const nextIp = () => {
  const n = sequence++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};
const run = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`http://localhost${path}`, init), bindings, createExecutionContext());
const rpc = async (method: string, params = {}, ip = nextIp()) => {
  const r = await run('/mcp', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': ip }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await r.text();
  expect(r.status, text).toBe(200);
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(l => l.startsWith('data:'))!.slice(5) : text).result;
};
it('routes, bounds actual bytes and declared lengths, and strictly limits each IP', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T08:00:15Z'));
  expect(await (await run('/')).text()).toContain('MCP 端點：/mcp');
  expect((await run('/nope')).status).toBe(404);
  expect((await run('/mcp', { method: 'DELETE' })).status).toBe(405);
  expect((await run('/mcp', { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.1' }, body: 'x'.repeat(65537) })).status).toBe(413);
  expect((await run('/mcp', { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.2', 'Content-Length': '65537' }, body: 'x' })).status).toBe(413);
  const ip = nextIp();
  for (let i = 1; i <= 30; i++) {
    expect((await run('/mcp', { headers: { 'CF-Connecting-IP': ip } })).status, `request ${i}`).not.toBe(429);
  }
  for (let i = 31; i <= 32; i++) {
    const response = await run('/mcp', { headers: { 'CF-Connecting-IP': ` ${ip} ` } });
    expect(response.status, `request ${i}`).toBe(429);
    expect(await response.text()).toBe('請求太頻繁，請稍後再試。');
    const retryAfter = response.headers.get('Retry-After');
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  }
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': nextIp() } })).status).not.toBe(429);
});
it('shares the limit across rotating IPv6 addresses in one /64', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T08:00:15Z'));
  const ips = ['2001:db8:aa:bb::1', '2001:db8:aa:bb:ffff::2'];
  for (let i = 0; i < 30; i++) {
    expect((await run('/mcp', { headers: { 'CF-Connecting-IP': ips[i % 2] } })).status, `request ${i + 1}`).not.toBe(429);
  }
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': ips[0] } })).status).toBe(429);
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': '2001:db8:aa:bc::1' } })).status).not.toBe(429);
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status).not.toBe(429);
});
it('shares one unknown bucket for missing, empty or invalid IPs, independently of real IPs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T08:00:15Z'));
  for (let i = 1; i <= 30; i++) expect((await run('/mcp')).status, `request ${i}`).not.toBe(429);
  expect((await run('/mcp')).status).toBe(429);
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': '' } })).status).toBe(429);
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': '   ' } })).status).toBe(429);
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': 'not-an-ip' } })).status).toBe(429);
  expect((await run('/mcp', { headers: { 'CF-Connecting-IP': nextIp() } })).status).not.toBe(429);
});
it.each(['GET', 'POST'].flatMap(method => ['idFromName', 'get', 'hit'].map(failure => ({ method, failure }))))(
  'fails open for $method /mcp when the rate-limit $failure call throws', async ({ method, failure }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unavailable = () => { throw new Error('private rate-limit details'); };
    const namespace = {
      idFromName: failure === 'idFromName' ? unavailable : () => 'test-shard',
      get: failure === 'get' ? unavailable : () => ({ hit: async () => unavailable() }),
    } as unknown as Env['MCP_RATE_LIMIT'];
    const response = await worker.fetch(new Request('http://localhost/mcp', {
      method,
      headers: { Host: 'localhost', 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } : {}),
    }), { ...bindings, MCP_RATE_LIMIT: namespace }, createExecutionContext());
    expect(response.status).not.toBe(500);
    expect(response.status).not.toBe(429);
    if (method === 'POST') expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(warn).toHaveBeenCalledExactlyOnceWith('mcp rate limit unavailable');
  },
);
it('lists exactly nine tools and serves seeded snapshots without upstream fetch', async () => {
  await seed();
  const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  try {
    expect((await rpc('tools/list')).tools.map((t: { name: string }) => t.name).sort()).toEqual(['garbage_schedule', 'invoice_check', 'invoice_get_winning_numbers', 'outage_schedule', 'stock_dividends', 'stock_quote', 'thsr_timetable', 'tra_live', 'tra_timetable']);
    for (const [name, args, expected] of [ ['stock_quote', { query: '2330' }, '台積電'], ['stock_quote', { query: '6488' }, '環球晶'], ['stock_dividends', {}, '近期除權息'], ['invoice_get_winning_numbers', {}, '統一發票中獎號碼'], ['invoice_check', { number: '54348835' }, '頭獎'] ] as const) {
      const result = await rpc('tools/call', { name, arguments: args }); const text = result.content[0].text;
      expect(text).toContain(expected); expect(text).not.toMatch(/undefined|null|NaN|\[object/);
    }
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
const heartbeat = { v: 1, lastSuccessAt: '2026-10-28T16:00:00.000Z', dataDate: '2026-10-22' };
it.each([
  { value: JSON.stringify(heartbeat), confirmed: true },
  // KV keys propagate independently: a newer heartbeat must not confirm older quotes.
  { value: JSON.stringify({ ...heartbeat, dataDate: '2026-10-23' }), confirmed: false },
  { value: JSON.stringify({ ...heartbeat, dataDate: '2026-10-21' }), confirmed: false },
  ...[null, 'invalid', 'null', JSON.stringify({ ...heartbeat, v: 2 }), JSON.stringify({ ...heartbeat, lastSuccessAt: 'invalid' }), JSON.stringify({ ...heartbeat, lastSuccessAt: '2026-02-30T00:00:00.000Z' }), JSON.stringify({ ...heartbeat, dataDate: '2026-02-30' }), JSON.stringify({ lastSuccessAt: heartbeat.lastSuccessAt })].map(value => ({ value, confirmed: false })),
])('reads TPEx heartbeat ($value), confirms only matching quotes and never writes from fetch', async ({ value, confirmed }) => {
  await seed();
  if (value === null) await bindings.SNAPSHOTS.delete(collectKeys.tpex);
  else await bindings.SNAPSHOTS.put(collectKeys.tpex, value);
  const get = vi.spyOn(bindings.SNAPSHOTS, 'get'), put = vi.spyOn(bindings.SNAPSHOTS, 'put'), del = vi.spyOn(bindings.SNAPSHOTS, 'delete');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T08:00:00Z'));
  try {
    const text = (await rpc('tools/call', { name: 'stock_quote', arguments: { query: '6488' } })).content[0].text;
    expect(get).toHaveBeenCalledWith(collectKeys.tpex);
    expect(text).toContain(confirmed ? '（注意：上櫃資料停在 115年10月22日；115年10月29日 已確認櫃買中心尚無更新資料，可能為休市）' : '（注意：上櫃資料停在 115年10月22日，可能尚未更新）');
    expect((await rpc('tools/call', { name: 'stock_quote', arguments: { query: '2330' } })).content[0].text).toContain('（注意：上市資料停在 115年10月22日，可能尚未更新）');
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it('serves the TPEx delay line through stock_quote with the collector heartbeat', async () => {
  await seed();
  const snapshot = decodeQuotesSnapshot((await bindings.SNAPSHOTS.get(keys.tpexQuotes))!);
  snapshot.rows = snapshot.rows.map(row => ({ ...row, date: { year: 2026, month: 10, day: 29 } }));
  await bindings.SNAPSHOTS.put(keys.tpexQuotes, encodeQuotesSnapshot(snapshot));
  await bindings.SNAPSHOTS.put(collectKeys.tpex, JSON.stringify({ v: 1, dataDate: '2026-10-29', lastSuccessAt: '2026-10-29T10:47:00Z' }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T11:00:00Z'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  const text = (await rpc('tools/call', { name: 'stock_quote', arguments: { query: '6488' } })).content[0].text;
  expect(text).toContain('⚠️ 櫃買資料可能延遲，最近一次更新：2026-10-29 18:47（台北時間）');
  expect(fetch).not.toHaveBeenCalled();
});
it('returns updating for empty KV and hides malformed data errors', async () => {
  for (const key of allKeys) await bindings.SNAPSHOTS.delete(key);
  for (const name of ['stock_quote', 'stock_dividends', 'invoice_get_winning_numbers', 'invoice_check']) {
    expect((await rpc('tools/call', { name, arguments: { query: '2330', number: '54348835' } })).content[0].text).toBe('資料更新中，請稍後再試');
  }
  await bindings.SNAPSHOTS.put(keys.twseQuotes, 'private error');
  expect((await rpc('tools/call', { name: 'stock_quote', arguments: { query: '2330' } })).content[0].text).toBe('暫時無法取得資料，請稍後再試。');
});
it('matches configured crons and both SQLite bindings and migrations', () => {
  const parsed = JSON.parse(config.replace(/\/\/[^\n]*/g, ''));
  expect(parsed.triggers.crons).toEqual(Object.keys(cronJobs));
  expect(Object.values(cronJobs)).toEqual(['twse', 'twse', 'invoice', 'invoice']);
  expect(parsed).not.toHaveProperty('ratelimits');
  expect(parsed.durable_objects.bindings).toContainEqual({ name: 'MCP_RATE_LIMIT', class_name: 'FixedWindowCounter' });
  expect(parsed.migrations).toContainEqual({ tag: 'v1', new_sqlite_classes: ['FixedWindowCounter'] });
  expect(parsed.durable_objects.bindings).toContainEqual({ name: 'TDX_GATEWAY', class_name: 'TdxGateway' });
  expect(parsed.migrations).toContainEqual({ tag: 'v2', new_sqlite_classes: ['TdxGateway'] });
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
const schedules = Object.entries(cronJobs).map(([cron, job]) => ({ cron, job, scheduledTime: Date.UTC(2026, 9, 27) }));
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
it('unknown local cron bootstraps invoice and TWSE, roundtrips payloads and skips all unchanged puts', async () => {
  for (const key of allKeys) await bindings.SNAPSHOTS.delete(key);
  const spy = mockUpstream();
  try {
    await worker.scheduled(createScheduledController({ cron: '' }), bindings, createExecutionContext());
    expect(spy).toHaveBeenCalledTimes(4);
    const bootstrapKeys = [keys.invoice, keys.twseQuotes, keys.twseDividends];
    const before = await Promise.all(bootstrapKeys.map(key => bindings.SNAPSHOTS.getWithMetadata<{ updatedAt: string }>(key)));
    for (const [i, { value, metadata }] of before.entries()) {
      const quotes = bootstrapKeys[i] === keys.twseQuotes;
      expect(quotes ? encodeQuotesSnapshot(decodeQuotesSnapshot(value!)) : encodeSnapshot(decodeSnapshot<object>(value!))).toBe(value);
      expect(Number.isFinite(Date.parse(metadata!.updatedAt))).toBe(true);
    }
    const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
    try {
      await worker.scheduled(createScheduledController({ cron: '' }), bindings, createExecutionContext());
      expect(put).not.toHaveBeenCalled();
      expect(await Promise.all(bootstrapKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
    } finally { put.mockRestore(); }
  } finally { spy.mockRestore(); }
});
it.each((['twse'] as const).flatMap(market => ['quotes', 'ratios', 'div'].map(failed => ({ market, failed }))))('keeps previous $market $failed data and still writes the independent snapshot', async ({ market, failed }) => {
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
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put'), del = vi.spyOn(bindings.SNAPSHOTS, 'delete');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const cron = Object.entries(cronJobs).find(([, job]) => job === 'twse')![0];
    await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(await Promise.all(allKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
    for (const kind of ['quotes', 'dividends'] as const) {
      expect(warn).toHaveBeenCalledWith(`${keys[kind === 'quotes' ? 'twseQuotes' : 'twseDividends']} fail ${kind}: no snapshot`);
    }
    spy.mockImplementation(async input => {
      const data = await fixtureFetch(String(input));
      return Response.json(String(input) === stockUrls['twse-quotes'] ? (fixtures[0] as typeof tq).map(row => ({ ...row, ClosingPrice: '2500' })) : data);
    });
    await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
    expect(put).toHaveBeenCalledTimes(1);
    const next = await bindings.SNAPSHOTS.getWithMetadata<{ updatedAt: string }>(keys.twseQuotes);
    expect(next.metadata!.updatedAt > '2026-10-26T00:00:00.000Z').toBe(true);
    expect(next.value).not.toBe(before[allKeys.indexOf(keys.twseQuotes)].value);
  } finally { spy.mockRestore(); put.mockRestore(); }
});

const modified = 'Tue, 27 Oct 2026 01:00:00 GMT';
const validators = (key: string, version = 1) => ({ etag: `"${key}-${version}"`, lastModified: modified });
const marketFeeds = (market: 'twse' | 'tpex') => Object.entries(stockUrls).filter(([key]) => key.startsWith(market));
const refresh = (market: 'twse' | 'invoice') => worker.scheduled(createScheduledController({ cron: Object.entries(cronJobs).find(([, job]) => job === market)![0] }), bindings, createExecutionContext());
const reset = async () => { for (const key of [...allKeys, ...Object.values(metaKeys), ...Object.values(collectKeys)]) await bindings.SNAPSHOTS.delete(key); };
const withValidators = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const [key] = Object.entries(stockUrls).find(([, url]) => url === String(input))!;
  return Response.json(await fixtureFetch(String(input)), { headers: { ETag: validators(key).etag, 'Last-Modified': modified } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['twse'] as const)('%s first fetch writes snapshots/meta; all-304 sends validators and performs no parsing or writes', async market => {
  await reset();
  const fetch = withValidators(), put = vi.spyOn(bindings.SNAPSHOTS, 'put'), del = vi.spyOn(bindings.SNAPSHOTS, 'delete');
  await refresh(market);
  expect(put.mock.calls.map(([key]) => key).sort()).toEqual([...marketKeys(market), metaKeys[market]].sort());
  const stored = Object.fromEntries(marketFeeds(market).map(([key]) => [key, validators(key)]));
  expect(JSON.parse((await bindings.SNAPSHOTS.get(metaKeys[market]))!)).toEqual(stored);
  put.mockClear(); fetch.mockClear();
  const log = vi.spyOn(console, 'log');
  fetch.mockImplementation(async (_input, init) => {
    const key = marketFeeds(market).find(([, url]) => url === String(_input))![0];
    const headers = new Headers(init?.headers);
    expect(headers.get('If-None-Match')).toBe(stored[key].etag);
    expect(headers.get('If-Modified-Since')).toBe(modified);
    expect(headers.get('User-Agent')).toBe(feedHeaders['user-agent']);
    expect(headers.get('Accept')).toBe(feedHeaders.accept);
    const response = new Response(null, { status: 304 });
    vi.spyOn(response, 'json').mockImplementation(() => { throw new Error('304 must not parse'); });
    return response;
  });
  await refresh(market);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(put).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(`stock:${market} 304 skip`);
});

it('mixed 200/304 re-fetches unchanged feeds unconditionally and builds the complete updated snapshot', async () => {
  await reset();
  const fetch = withValidators();
  await refresh('twse');
  fetch.mockClear();
  fetch.mockImplementation(async (input, init) => {
    const url = String(input), [key] = marketFeeds('twse').find(([, url]) => url === String(input))!;
    if (key !== 'twse-quotes' && new Headers(init?.headers).has('If-None-Match')) return new Response(null, { status: 304 });
    const data = key === 'twse-quotes' ? (fixtures[0] as typeof tq).map(row => ({ ...row, ClosingPrice: '2500' })) : await fixtureFetch(url);
    return Response.json(data, { headers: { ETag: validators(key, key === 'twse-quotes' ? 2 : 1).etag, 'Last-Modified': modified } });
  });
  await refresh('twse');
  expect(fetch).toHaveBeenCalledTimes(5);
  for (const [, init] of fetch.mock.calls.slice(3)) expect(Object.fromEntries(new Headers(init?.headers))).toEqual(feedHeaders);
  const next = decodeQuotesSnapshot((await bindings.SNAPSHOTS.get(keys.twseQuotes))!);
  expect(next.rows).toHaveLength(100);
  expect(next.rows.every(row => row.close === 2500)).toBe(true);
  expect(next.rows.find(row => row.code === '2330')!.pe).not.toBeNull();
  expect(JSON.parse((await bindings.SNAPSHOTS.get(metaKeys.twse))!)['twse-quotes']).toEqual(validators('twse-quotes', 2));
});

it('feeds without validators stay unconditional and never store meta', async () => {
  await reset();
  const fetch = mockUpstream(), put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  await refresh('twse'); await refresh('twse');
  expect(fetch).toHaveBeenCalledTimes(6);
  for (const [, init] of fetch.mock.calls) expect(Object.fromEntries(new Headers(init?.headers))).toEqual(feedHeaders);
  expect(await bindings.SNAPSHOTS.get(metaKeys.twse)).toBeNull();
  expect(put).toHaveBeenCalledTimes(2);
});

it.each(['quotes', 'dividends'] as const)('ignores stored meta when the %s snapshot is missing', async kind => {
  await reset();
  const fetch = withValidators();
  await refresh('twse');
  await bindings.SNAPSHOTS.delete(kind === 'quotes' ? keys.twseQuotes : keys.twseDividends);
  fetch.mockClear();
  await refresh('twse');
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, init] of fetch.mock.calls) expect(Object.fromEntries(new Headers(init?.headers))).toEqual(feedHeaders);
  for (const key of marketKeys('twse')) expect(await bindings.SNAPSHOTS.get(key)).not.toBeNull();
});

it.each(['twse'] as const)('guards tiny %s quotes, retains previous snapshots and deletes stale meta', async market => {
  await reset();
  const fetch = withValidators();
  await refresh(market);
  const before = await Promise.all(marketKeys(market).map(key => bindings.SNAPSHOTS.getWithMetadata(key)));
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put'), warning = vi.spyOn(console, 'warn');
  fetch.mockImplementation(async input => Response.json(String(input) === stockUrls[`${market}-quotes`] ? tq : await fixtureFetch(String(input)), { headers: { ETag: '"changed"' } }));
  await refresh(market);
  expect(put).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(`${keys[`${market}Quotes`]} guard ${tq.length} rows`);
  expect(await Promise.all(marketKeys(market).map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
  expect(await bindings.SNAPSHOTS.get(metaKeys[market])).toBeNull();
});

it('guards empty invoice draws and keeps the old value', async () => {
  await reset(); await seed();
  const before = await bindings.SNAPSHOTS.getWithMetadata(keys.invoice);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<rss><channel></channel></rss>'));
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put'), warning = vi.spyOn(console, 'warn');
  await refresh('invoice');
  expect(put).not.toHaveBeenCalled();
  // The existing parser rejects feeds with no draws before a snapshot is built.
  expect(warning).toHaveBeenCalledExactlyOnceWith(`${keys.invoice} fail Error: 財政部資料中沒有可解析的開獎期別`);
  expect(await bindings.SNAPSHOTS.getWithMetadata(keys.invoice)).toEqual(before);
});

it.each(['fetch', 'parse', 'write'] as const)('deletes stale validators after a %s failure', async failure => {
  await reset();
  const fetch = withValidators();
  await refresh('twse');
  expect(await bindings.SNAPSHOTS.get(metaKeys.twse)).not.toBeNull();
  fetch.mockImplementation(async input => {
    if (String(input) === stockUrls['twse-quotes']) {
      if (failure === 'fetch') throw new Error('private details');
      if (failure === 'parse') return Response.json({ private: 'bad shape' }, { headers: { ETag: '"changed"' } });
      return Response.json((fixtures[0] as typeof tq).map(row => ({ ...row, ClosingPrice: '2500' })), { headers: { ETag: '"changed"' } });
    }
    return Response.json(await fixtureFetch(String(input)), { headers: { ETag: '"changed"' } });
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (failure === 'write') vi.spyOn(bindings.SNAPSHOTS, 'put').mockRejectedValue(new Error('kv boom'));
  await refresh('twse');
  if (failure === 'write') expect(warn).toHaveBeenCalledExactlyOnceWith(`${keys.twseQuotes} fail Error: kv boom`);
  expect(await bindings.SNAPSHOTS.get(metaKeys.twse)).toBeNull();
});

it('logs the error name and message when the stock job fails before fetching', async () => {
  const fetch = mockUpstream();
  vi.spyOn(bindings.SNAPSHOTS, 'get').mockRejectedValue(new Error('kv read boom'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await refresh('twse');
  expect(warn).toHaveBeenCalledExactlyOnceWith('stock:twse fail Error: kv read boom');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['twse'] as const)('deletes %s meta after a partial update so the next run fetches unconditionally', async market => {
  await reset();
  const fetch = withValidators();
  await refresh(market);
  expect(await bindings.SNAPSHOTS.get(metaKeys[market])).not.toBeNull();
  const before = await bindings.SNAPSHOTS.getWithMetadata(keys[`${market}Dividends`]);
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put'), del = vi.spyOn(bindings.SNAPSHOTS, 'delete');
  fetch.mockImplementation(async input => {
    const url = String(input);
    if (url === stockUrls[`${market}-div`]) return new Response('unavailable', { status: 503 });
    const data = await fixtureFetch(url);
    return Response.json(url === stockUrls[`${market}-quotes`] ? data.map((row: object) => ({ ...row, ClosingPrice: '2500' })) : data, { headers: { ETag: '"changed"' } });
  });
  await refresh(market);
  expect(put.mock.calls.map(([key]) => key)).toEqual([keys[`${market}Quotes`]]);
  expect(del).toHaveBeenCalledExactlyOnceWith(metaKeys[market]);
  expect(await bindings.SNAPSHOTS.get(metaKeys[market])).toBeNull();
  expect(await bindings.SNAPSHOTS.getWithMetadata(keys[`${market}Dividends`])).toEqual(before);
  fetch.mockClear();
  fetch.mockImplementation(async input => Response.json(await fixtureFetch(String(input))));
  await refresh(market);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, init] of fetch.mock.calls) expect(Object.fromEntries(new Headers(init?.headers))).toEqual(feedHeaders);
  expect(del).toHaveBeenCalledTimes(1);
});

it('advances changed validators on unchanged snapshots, skips unchanged meta, and permits empty dividends', async () => {
  await reset();
  const fetch = withValidators();
  await refresh('twse');
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  await refresh('twse');
  expect(put).not.toHaveBeenCalled();
  fetch.mockImplementation(async input => Response.json(String(input) === stockUrls['twse-div'] ? [] : await fixtureFetch(String(input)), { headers: { ETag: '"changed"' } }));
  await refresh('twse');
  expect(put.mock.calls.map(([key]) => key).sort()).toEqual([keys.twseDividends, metaKeys.twse].sort());
  expect(decodeSnapshot<{ rows: unknown[] }>((await bindings.SNAPSHOTS.get(keys.twseDividends))!).rows).toEqual([]);
  put.mockClear();
  fetch.mockImplementation(async input => Response.json(String(input) === stockUrls['twse-div'] ? [] : await fixtureFetch(String(input)), { headers: { ETag: '"new"' } }));
  await refresh('twse');
  expect(put.mock.calls.map(([key]) => key)).toEqual([metaKeys.twse]);
});

it.each([...Object.keys(cronJobs), '', '15,45 * * * MON-FRI', '0,30 */6 * * SAT,SUN'])('cron %j never fetches or changes TPEx and still serves seeded TPEx', async cron => {
  await reset();
  await seed();
  const protectedKeys = [keys.tpexQuotes, keys.tpexDividends, 'stock:meta:tpex:v1', collectKeys.tpex];
  const before = await Promise.all(protectedKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)));
  const fetch = mockUpstream(), put = vi.spyOn(bindings.SNAPSHOTS, 'put'), del = vi.spyOn(bindings.SNAPSHOTS, 'delete');
  await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
  expect(fetch.mock.calls.some(([url]) => new URL(String(url)).hostname.endsWith('tpex.org.tw'))).toBe(false);
  for (const spy of [put, del]) expect(spy.mock.calls.some(([key]) => protectedKeys.includes(key))).toBe(false);
  expect(await Promise.all(protectedKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
  fetch.mockClear();
  expect((await rpc('tools/call', { name: 'stock_quote', arguments: { query: '6488' } })).content[0].text).toContain('環球晶');
  expect((await rpc('tools/call', { name: 'stock_dividends', arguments: { query: '2063' } })).content[0].text).toContain('世鎧');
  expect(fetch).not.toHaveBeenCalled();
});

it('serves garbage schedules from KV without upstream requests', async () => {
  const { indexKey, shardKey, encodeIndex, encodeShard } = await import('../../src/core/garbage/snapshot.js');
  const date = '2026-10-30T00:00:00Z';
  await bindings.SNAPSHOTS.put(indexKey, encodeIndex({ v: 2, generatedAt: date, cities: { ntpc: { gen: 'abc', fetchedAt: date, updatedAt: date, stops: 1, districts: { 板橋區: { stops: 1, sha256: 'a'.repeat(64) } } } } }));
  await bindings.SNAPSHOTS.put(shardKey('ntpc', 'abc', '板橋區'), encodeShard({ v: 2, stops: [{ district: '板橋區', village: '文化里', route: 'A', name: '文化路', garbage: [{ days: 2, start: '16:00', end: '' }], recycling: [], food: [] }] }));
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const result = await rpc('tools/call', { name: 'garbage_schedule', arguments: { city: '新北', keyword: '板橋文化路' } });
  expect(result.content[0].text).toContain('文化路');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('serves planned outages from only the index and requested county KV shard', async () => {
  const { indexKey, shardKey } = await import('../../src/core/outage/model.js');
  const date = '2026-11-01T00:00:00Z';
  await bindings.SNAPSHOTS.put(indexKey, JSON.stringify({ v: 1, generatedAt: date, sources: { taipower: { ok: true, fetchedAt: date, lastSuccessAt: date, counties: { 臺北市: { sha: 'a'.repeat(64), count: 1 }, 臺中市: { sha: 'b'.repeat(64), count: 1 } } } } }));
  await bindings.SNAPSHOTS.put(shardKey('taipower', '臺北市'), JSON.stringify([{ s: 'taipower', k: 'power', c: '臺北市', d: '信義區', t: [['2026-11-05T23:20', '2026-11-06T00:49']], a: '臺北市信義區松仁路', r: '改良工程', n: 'T1', u: 'https://service.taipower.com.tw/branch/d102', o: '台電台北區營業處' }]));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('outage Worker must not fetch upstream'));
  const get = vi.spyOn(bindings.SNAPSHOTS, 'get'), put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  const result = await rpc('tools/call', { name: 'outage_schedule', arguments: { city: '台北', district: '信義區', type: 'power', start_date: '2026-11-06', end_date: '2026-11-06' } });
  expect(result.content[0].text).toContain('松仁路'); expect(result.content[0].text).toContain('11/06（五）00:49');
  expect(get.mock.calls.map(([key]) => key)).toEqual([indexKey, shardKey('taipower', '臺北市')]); expect(fetch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(Object.keys(cronJobs)).toHaveLength(4);
});
it('reports missing or undecodable outage KV data without upstream fallback', async () => {
  const { indexKey, shardKey } = await import('../../src/core/outage/model.js');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('no outage network'));
  const args = { city: '臺北市', type: 'power', start_date: '2026-11-01', end_date: '2026-11-07' };
  for (const raw of [null, '{}', JSON.stringify({ v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { taipower: { ok: true, lastSuccessAt: '2026-11-01T00:00:00Z', counties: { 臺北市: { sha: 'a'.repeat(64), count: 1 } } } } })]) {
    if (raw === null) await bindings.SNAPSHOTS.delete(indexKey); else await bindings.SNAPSHOTS.put(indexKey, raw);
    for (const shard of [null, '[{}]']) {
      if (shard === null) await bindings.SNAPSHOTS.delete(shardKey('taipower', '臺北市')); else await bindings.SNAPSHOTS.put(shardKey('taipower', '臺北市'), shard);
      const result = await rpc('tools/call', { name: 'outage_schedule', arguments: args }); expect(result.content[0].text).toContain('台電：該來源暫時無法取得'); expect(result.content[0].text).not.toContain('官方公告中查無');
    }
  }
  expect(fetch).not.toHaveBeenCalled();
});
