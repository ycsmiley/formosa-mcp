import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { registerToolsets, toolsets } from '../mcp/toolsets.js';
import { buildInvoiceSnapshot, buildStockSnapshot, encodeSnapshot, decodeSnapshot, type InvoiceSnapshot, type StockSnapshot } from '../core/snapshot.js';
import type { StockMarketSnapshot } from '../core/stock/service.js';
import type { StockQuote, DividendEvent } from '../core/stock/parse.js';
import { fetchInvoiceFeed } from '../core/invoice/source.js';
import { fetchJson } from '../core/stock/source.js';
export interface Env { SNAPSHOTS: KVNamespace; RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> } }
export const keys = { invoice: 'invoice:v1', quotes: 'stock:quotes:v1', dividends: 'stock:dividends:v1' };
async function read<T>(env: Env, key: string): Promise<T | null> { const raw = await env.SNAPSHOTS.get(key); return raw === null ? null : decodeSnapshot<T>(raw); }
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
          snapshot: { quotes: () => read<StockMarketSnapshot<StockQuote>>(env, keys.quotes), dividends: () => read<StockMarketSnapshot<DividendEvent>>(env, keys.dividends) },
        });
        return server;
      }, { route: '/mcp' });
      return await handler(request, env, ctx);
    } catch { return plain('伺服器暫時出錯，請稍後再試。', 500); }
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    async function write(key: string, snapshot: object) {
      const encoded = encodeSnapshot(snapshot); const old = await env.SNAPSHOTS.get(key);
      // Timestamps describe the last data change; unchanged data consumes no KV write.
      if (old && encodeSnapshot({ ...decodeSnapshot<object>(old), updatedAt: '' }) === encodeSnapshot({ ...snapshot, updatedAt: '' })) return;
      await env.SNAPSHOTS.put(key, encoded); console.log(`${key} ${new TextEncoder().encode(encoded).length} bytes ok`);
    }
    const invoiceCron = ['0 */3 * * *', '*/10 5-15 25 1,3,5,7,9,11 *'];
    const stockCron = ['*/30 * * * 1-5', '0 */6 * * *'];
    const unknown = ![...invoiceCron, ...stockCron].includes(controller.cron);
    await Promise.all([
      (async () => { if (unknown || invoiceCron.includes(controller.cron)) { try { await write(keys.invoice, await buildInvoiceSnapshot(fetchInvoiceFeed)); } catch { console.log(`${keys.invoice} fail`); } } })(),
      (async () => { if (unknown || stockCron.includes(controller.cron)) { try {
        const previous: Partial<StockSnapshot> = { quotes: await read(env, keys.quotes) ?? undefined, dividends: await read(env, keys.dividends) ?? undefined };
        const data = await buildStockSnapshot(fetchJson, previous);
        for (const kind of ['quotes', 'dividends'] as const) { if (data[kind].twse || data[kind].tpex) await write(keys[kind], data[kind]); else console.log(`${keys[kind]} fail`); }
      } catch { console.log('stock fail'); } } })(),
    ]);
  },
};
