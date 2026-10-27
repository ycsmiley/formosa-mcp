import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { keys, metaKeys, cronJobs, type Env } from '../../src/worker/index.js';
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
it('lists exactly four tools (rail excluded) and serves seeded snapshots without upstream fetch', async () => {
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
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put'), del = vi.spyOn(bindings.SNAPSHOTS, 'delete');
  try {
    const cron = Object.entries(cronJobs).find(([, job]) => job === 'twse')![0];
    await worker.scheduled(createScheduledController({ cron }), bindings, createExecutionContext());
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(await Promise.all(allKeys.map(key => bindings.SNAPSHOTS.getWithMetadata(key)))).toEqual(before);
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
const refresh = (market: 'twse' | 'tpex' | 'invoice') => worker.scheduled(createScheduledController({ cron: Object.entries(cronJobs).find(([, job]) => job === market)![0] }), bindings, createExecutionContext());
const reset = async () => { for (const key of [...allKeys, ...Object.values(metaKeys)]) await bindings.SNAPSHOTS.delete(key); };
const withValidators = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const [key] = Object.entries(stockUrls).find(([, url]) => url === String(input))!;
  return Response.json(await fixtureFetch(String(input)), { headers: { ETag: validators(key).etag, 'Last-Modified': modified } });
});
afterEach(() => vi.restoreAllMocks());

it.each(['twse', 'tpex'] as const)('%s first fetch writes snapshots/meta; all-304 sends validators and performs no parsing or writes', async market => {
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
  for (const [, init] of fetch.mock.calls.slice(3)) expect([...new Headers(init?.headers)]).toEqual([]);
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
  for (const [, init] of fetch.mock.calls) expect([...new Headers(init?.headers)]).toEqual([]);
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
  for (const [, init] of fetch.mock.calls) expect([...new Headers(init?.headers)]).toEqual([]);
  for (const key of marketKeys('twse')) expect(await bindings.SNAPSHOTS.get(key)).not.toBeNull();
});

it.each(['twse', 'tpex'] as const)('guards tiny %s quotes, retains previous snapshots and deletes stale meta', async market => {
  await reset();
  const fetch = withValidators();
  await refresh(market);
  const before = await Promise.all(marketKeys(market).map(key => bindings.SNAPSHOTS.getWithMetadata(key)));
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put'), warning = vi.spyOn(console, 'warn');
  fetch.mockImplementation(async input => Response.json(String(input) === stockUrls[`${market}-quotes`] ? (market === 'twse' ? tq : pq) : await fixtureFetch(String(input)), { headers: { ETag: '"changed"' } }));
  await refresh(market);
  expect(put).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(`${keys[`${market}Quotes`]} guard ${market === 'twse' ? tq.length : pq.length} rows`);
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
  expect(warning).toHaveBeenCalledWith(`${keys.invoice} fail`);
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
  if (failure === 'write') vi.spyOn(bindings.SNAPSHOTS, 'put').mockRejectedValue(new Error('private details'));
  await refresh('twse');
  expect(await bindings.SNAPSHOTS.get(metaKeys.twse)).toBeNull();
});

it.each(['twse', 'tpex'] as const)('deletes %s meta after a partial update so the next run fetches unconditionally', async market => {
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
    return Response.json(url === stockUrls[`${market}-quotes`] ? data.map((row: object) => ({ ...row, [market === 'twse' ? 'ClosingPrice' : 'Close']: '2500' })) : data, { headers: { ETag: '"changed"' } });
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
  for (const [, init] of fetch.mock.calls) expect([...new Headers(init?.headers)]).toEqual([]);
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
