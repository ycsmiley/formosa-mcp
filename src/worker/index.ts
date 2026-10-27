import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { registerToolsets, toolsets } from '../mcp/toolsets.js';
import { buildInvoiceSnapshot, buildStockSnapshot, mergeStockSnapshots, encodeQuotesSnapshot, decodeQuotesSnapshot, encodeSnapshot, decodeSnapshot, type InvoiceSnapshot, type MarketSnapshot } from '../core/snapshot.js';
import type { StockQuote, DividendEvent } from '../core/stock/parse.js';
import { fetchInvoiceFeed } from '../core/invoice/source.js';
import { fetchJson } from '../core/stock/source.js';
export interface Env { SNAPSHOTS: KVNamespace; RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> } }
export const keys = { invoice: 'invoice:v1', twseQuotes: 'stock:quotes:twse:v1', tpexQuotes: 'stock:quotes:tpex:v1', twseDividends: 'stock:dividends:twse:v1', tpexDividends: 'stock:dividends:tpex:v1' };
export const cronJobs = {
  '0,30 * * * MON-FRI': 'twse',
  '15,45 * * * MON-FRI': 'tpex',
  '0,30 */6 * * SAT,SUN': 'weekend',
  '0 */3 * * *': 'invoice',
  '*/10 5-15 25 1,3,5,7,9,11 *': 'invoice',
} as const;
const isQuotes = (key: string) => key === keys.twseQuotes || key === keys.tpexQuotes;
async function read<T>(env: Env, key: string): Promise<T | null> {
  const { value, metadata } = await env.SNAPSHOTS.getWithMetadata<{ updatedAt: string }>(key);
  if (value === null) return null;
  const data = isQuotes(key) ? decodeQuotesSnapshot(value) : decodeSnapshot<{ updatedAt: string }>(value);
  return { ...data, updatedAt: metadata?.updatedAt ?? data.updatedAt } as T;
}
async function readMarkets<T>(env: Env, twseKey: string, tpexKey: string) {
  const [twse, tpex] = await Promise.all([read<MarketSnapshot<T>>(env, twseKey), read<MarketSnapshot<T>>(env, tpexKey)]);
  return mergeStockSnapshots(twse, tpex);
}
const plain = (text: string, status = 200, headers = {}) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/' && request.method === 'GET') return plain('formosa-mcp：讓 AI agent 懂台灣的 MCP server。MCP 端點：/mcp');
      if (path !== '/mcp') return plain('找不到這個頁面。', 404);
      if (!['POST', 'GET', 'OPTIONS'].includes(request.method)) return plain('不支援這個請求方法。', 405, { Allow: 'GET, POST, OPTIONS' });
      if (!(await env.RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success) return plain('請求太頻繁，請稍後再試。', 429, { 'Retry-After': '60' });
      if (Number(request.headers.get('Content-Length')) > 65536) return plain('請求內容太大。', 413);
      if (request.body) {
        const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 65536) { await reader.cancel(); return plain('請求內容太大。', 413); } chunks.push(value); }
        const body = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        request = new Request(request.url, { method: request.method, headers: request.headers, body });
      }
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'formosa-mcp', version: '0.1.0' });
        registerToolsets(server, toolsets, {}, {
          loadDraws: async () => (await read<InvoiceSnapshot>(env, keys.invoice))?.draws ?? null,
          snapshot: { quotes: () => readMarkets<StockQuote>(env, keys.twseQuotes, keys.tpexQuotes), dividends: () => readMarkets<DividendEvent>(env, keys.twseDividends, keys.tpexDividends) },
        });
        return server;
      }, { route: '/mcp' });
      return await handler(request, env, ctx);
    } catch { return plain('伺服器暫時出錯，請稍後再試。', 500); }
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    async function write(key: string, snapshot: { updatedAt: string }) {
      // Stable payloads compare directly, without decoding the old value. Metadata
      // holds the last data-change time and is preserved when the payload is unchanged.
      const stable = { ...snapshot, updatedAt: '' };
      const encoded = isQuotes(key) ? encodeQuotesSnapshot(stable as MarketSnapshot<StockQuote>) : encodeSnapshot(stable);
      if (await env.SNAPSHOTS.get(key) === encoded) return;
      await env.SNAPSHOTS.put(key, encoded, { metadata: { updatedAt: snapshot.updatedAt } });
      console.log(`${key} ${new TextEncoder().encode(encoded).length} bytes ok`);
    }
    const configured = Object.hasOwn(cronJobs, controller.cron) ? cronJobs[controller.cron as keyof typeof cronJobs] : undefined;
    const job = configured === 'weekend' ? (new Date(controller.scheduledTime).getUTCMinutes() < 30 ? 'twse' : 'tpex') : configured;
    // Production only sends configured crons. Unknown cron is local bootstrap.
    const jobs = job ? [job] : ['invoice', 'twse', 'tpex'] as const;
    await Promise.all(jobs.map(async job => {
      if (job === 'invoice') {
        try { await write(keys.invoice, await buildInvoiceSnapshot(fetchInvoiceFeed)); } catch { console.log(`${keys.invoice} fail`); }
        return;
      }
      const data = await buildStockSnapshot(job, fetchJson);
      await Promise.all((['quotes', 'dividends'] as const).map(async kind => {
        const key = keys[`${job}${kind === 'quotes' ? 'Quotes' : 'Dividends'}`];
        try { if (data[kind]) await write(key, data[kind]); else console.log(`${key} fail`); } catch { console.log(`${key} fail`); }
      }));
    }));
  },
};
