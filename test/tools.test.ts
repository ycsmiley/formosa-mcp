import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { stockFetch } from './stock-fixtures.js';
const xml = readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8');
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); });
async function setup(date: string | (() => Date) = '2026-10-26T00:00:00+08:00', fetchFeed = async () => xml) {
  const server = createServer({ fetchJson: stockFetch, fetchFeed, clock: typeof date === 'function' ? date : () => new Date(date) });
  const client = new Client({ name: 'test-client', version: '1' });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return client;
}
function output(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text: string }[];
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}
it('calls both tools end-to-end with SDK client and caches the feed', async () => {
  const fetchFeed = vi.fn(async () => xml);
  const client = await setup(undefined, fetchFeed);
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['invoice_get_winning_numbers', 'invoice_check', 'stock_quote', 'stock_dividends']);
  expect(output(await client.callTool({ name: 'invoice_get_winning_numbers', arguments: {} }))).toContain('統一發票中獎號碼｜115年07-08月');
  const result = output(await client.callTool({ name: 'invoice_check', arguments: { number: '54348835' } }));
  expect(result).toContain('【115年07-08月】恭喜！中了 頭獎');
  expect(result).toContain('【115年05-06月】沒中');
  expect(fetchFeed).toHaveBeenCalledTimes(1);
});
it('does not check previous period once its claim period ends', async () => {
  const client = await setup('2026-11-06T00:00:00+08:00');
  const result = output(await client.callTool({ name: 'invoice_check', arguments: { number: '54348835' } }));
  expect(result).not.toContain('115年05-06月');
});
it('explicit period checks only that period', async () => {
  const client = await setup();
  const result = output(await client.callTool({ name: 'invoice_check', arguments: { number: '24121106', period: '11505' } }));
  expect(result).toContain('【115年05-06月】恭喜！中了 頭獎');
  expect(result).not.toContain('115年07-08月');
});
it.each(['invoice_get_winning_numbers', 'invoice_check'])('%s uses feed presence rather than date-rule predictions', async name => {
  const client = await setup('2026-11-26T00:00:00+08:00');
  const result = await client.callTool({ name, arguments: { number: '54348835', period: '11510' } });
  expect(output(result)).toContain('尚未開獎');
  expect(output(result)).toContain('預計 115年11月25日開獎');
  expect(result.isError).not.toBe(true);
  expect(output(await client.callTool({ name, arguments: { number: '54348835', period: '11201' } }))).toContain('只提供最近 6 期');
});
it.each(['invoice_get_winning_numbers', 'invoice_check'])('%s handles invalid period and network errors', async name => {
  const client = await setup(undefined, async () => { throw new Error('連線逾時'); });
  const bad = await client.callTool({ name, arguments: { number: '54348835', period: 'garbage' } });
  expect(output(bad)).toContain('例如 11509、115年9-10月');
  expect(bad.isError).toBe(true);
  const offline = await client.callTool({ name, arguments: { number: '54348835' } });
  expect(output(offline)).toBe('目前連不到財政部資料來源，請稍後再試（錯誤：連線逾時）');
  expect(offline.isError).toBe(true);
});
it('invalid number returns friendly error before loading', async () => {
  const fetchFeed = vi.fn(async () => xml);
  const client = await setup(undefined, fetchFeed);
  const result = await client.callTool({ name: 'invoice_check', arguments: { number: '12a45678' } });
  expect(result.isError).toBe(true);
  expect(output(result)).toContain('請輸入');
  expect(fetchFeed).not.toHaveBeenCalled();
});
it('tool output cleanliness includes errors and missing periods', async () => {
  const client = await setup();
  for (const period of ['11510', '11201', 'bad']) {
    const value = output(await client.callTool({ name: 'invoice_get_winning_numbers', arguments: { period } }));
    expect(value).not.toMatch(/undefined|null|\[object Object\]|NaN/);
    expect(value).not.toContain('{"');
    expect(() => JSON.parse(value)).toThrow();
  }
});

const newerXml = xml.replace('</channel>', `<item>
  <title>11510</title>
  <description><![CDATA[<p>特別獎：89996565</p><p>特獎：91098182</p><p>頭獎：54348835、44991397、06595111</p>]]></description>
</item></channel>`);
it.each([
  ['2026-11-25T10:00:00+08:00', false, 2],
  ['2026-11-25T10:00:00+08:00', true, 1],
  ['2026-11-20T10:00:00+08:00', false, 1],
])('cache refresh at %s with current feed %s', async (date, current, calls) => {
  const start = new Date(date).getTime();
  let now = start;
  const fetchFeed = vi.fn(async () => current ? newerXml : xml);
  const client = await setup(() => new Date(now), fetchFeed);
  const call = () => client.callTool({ name: 'invoice_get_winning_numbers', arguments: {} });
  await call();
  now = start + 11 * 60 * 1000;
  await call();
  expect(fetchFeed).toHaveBeenCalledTimes(calls);
  if (date.startsWith('2026-11-20')) {
    now = start + (6 * 60 + 1) * 60 * 1000;
    await call();
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  }
});
it.each(['11510', undefined])('shows claim start for a newly announced period (%s)', async period => {
  const client = await setup('2026-11-26T00:00:00+08:00', async () => newerXml);
  const result = output(await client.callTool({ name: 'invoice_check', arguments: { number: '54348835', period } }));
  expect(result).toContain('領獎期間 115年12月06日 起，還不能領');
});
it('does not show the early claim notice after claim start', async () => {
  const client = await setup();
  const result = output(await client.callTool({ name: 'invoice_check', arguments: { number: '54348835', period: '11508' } }));
  expect(result).not.toContain('還不能領');
});

it('calls all stock tools through MCP with clean text output', async () => {
  const client = await setup();
  for (const [name, args] of [
    ...['2330', '台積電', '6488', '不存在的股票zz', '國泰', '00719B', '020001'].map(query => ['stock_quote', { query }] as const),
    ['stock_dividends', {}], ['stock_dividends', { query: '2330' }],
  ] as const) {
    const reply = await client.callTool({ name, arguments: args });
    const text = output(reply);
    expect(reply.isError).not.toBe(true);
    expect(text).not.toMatch(/undefined|null|NaN|\{|\[object/);
    if ('query' in args && args.query === '6488') expect(text).toContain('環球晶（6488）｜上櫃');
    if (name === 'stock_quote' && 'query' in args && ['2330', '台積電'].includes(args.query!)) expect(text).toContain('台積電（2330）｜上市');
    if ('query' in args && args.query === '不存在的股票zz') expect(text).toContain('找不到');
    if (name === 'stock_dividends') expect(text).toContain('近期除權息');
  }
});
