import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInvoiceToolset } from '../src/toolsets/invoice/index.js';
const xml = readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8');
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); });
async function setup(date = '2026-10-26T00:00:00+08:00', fetchFeed = async () => xml) {
  const server = new McpServer({ name: 'test', version: '1' });
  createInvoiceToolset({ fetchFeed, clock: () => new Date(date) }).register(server);
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
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['invoice_get_winning_numbers', 'invoice_check']);
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
