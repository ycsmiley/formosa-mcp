import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { registerToolsets, toolsets } from '../mcp/toolsets.js';
import { buildInvoiceSnapshot, buildStockSnapshot, mergeStockSnapshots, decodeQuotesSnapshot, decodeSnapshot, type InvoiceSnapshot, type MarketSnapshot } from '../core/snapshot.js';
import type { StockQuote, DividendEvent } from '../core/stock/parse.js';
import { fetchInvoiceFeed } from '../core/invoice/source.js';
import { stockUrls } from '../core/stock/source.js';
import { decodeStockMeta, fetchStockFeed, type StockMeta } from './stock-source.js';
import { collectKeys, keys, metaKeys, minimumRows, isQuotes, encodeStoredSnapshot } from './snapshot-keys.js';
export { keys, metaKeys } from './snapshot-keys.js';
export interface Env { SNAPSHOTS: KVNamespace; RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> } }
export const cronJobs = {
  '0,30 * * * MON-FRI': 'twse',
  '0 */6 * * SAT,SUN': 'twse',
  '0 */3 * * *': 'invoice',
  '*/10 5-15 25 1,3,5,7,9,11 *': 'invoice',
} as const;
async function read<T>(env: Env, key: string): Promise<T | null> {
  const { value, metadata } = await env.SNAPSHOTS.getWithMetadata<{ updatedAt: string }>(key);
  if (value === null) return null;
  const data = isQuotes(key) ? decodeQuotesSnapshot(value) : decodeSnapshot<{ updatedAt: string }>(value);
  return { ...data, updatedAt: metadata?.updatedAt ?? data.updatedAt } as T;
}
async function readTpexCheckedAt(env: Env): Promise<string | undefined> {
  try {
    const data = JSON.parse(await env.SNAPSHOTS.get(collectKeys.tpex) ?? 'null');
    if (data?.v !== 1 || typeof data.lastSuccessAt !== 'string' || typeof data.dataDate !== 'string') return;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.lastSuccessAt) || !Number.isFinite(Date.parse(data.lastSuccessAt))) return;
    if ([data.dataDate, data.lastSuccessAt.slice(0, 10)].some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)) return;
    return data.lastSuccessAt;
  } catch { /* Missing or invalid collector state does not affect quotes. */ }
}
async function readMarkets<T>(env: Env, twseKey: string, tpexKey: string) {
  const [twse, tpex, checkedAt] = await Promise.all([read<MarketSnapshot<T>>(env, twseKey), read<MarketSnapshot<T>>(env, tpexKey), isQuotes(tpexKey) ? readTpexCheckedAt(env) : undefined]);
  return mergeStockSnapshots(twse, tpex, checkedAt);
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
        registerToolsets(server, toolsets.filter(t => t.name === 'invoice' || t.name === 'stock'), {}, {
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
      const encoded = encodeStoredSnapshot(key, snapshot);
      if (await env.SNAPSHOTS.get(key) === encoded) return;
      await env.SNAPSHOTS.put(key, encoded, { metadata: { updatedAt: snapshot.updatedAt } });
      console.log(`${key} ${new TextEncoder().encode(encoded).length} bytes ok`);
    }
    const job = Object.hasOwn(cronJobs, controller.cron) ? cronJobs[controller.cron as keyof typeof cronJobs] : undefined;
    // Production only sends configured crons. Unknown cron is local bootstrap.
    const jobs = job ? [job] : ['invoice', 'twse'] as const;
    await Promise.all(jobs.map(async job => {
      if (job === 'invoice') {
        try {
          const snapshot = await buildInvoiceSnapshot(fetchInvoiceFeed);
          if (snapshot.draws.length < minimumRows.invoice) console.warn(`${keys.invoice} guard ${snapshot.draws.length} rows`);
          else await write(keys.invoice, snapshot);
        } catch (error) { console.warn(`${keys.invoice} fail ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`); }
        return;
      }
      try {
        const snapshotKeys = [keys[`${job}Quotes`], keys[`${job}Dividends`]];
        async function exists(key: string) {
          const stream = await env.SNAPSHOTS.get(key, 'stream');
          if (!stream) return false;
          await stream.cancel();
          return true;
        }
        const [previous, ...present] = await Promise.all([env.SNAPSHOTS.get(metaKeys[job]), ...snapshotKeys.map(exists)]);
        const meta = present.every(Boolean) ? decodeStockMeta(previous) : {};
        const feeds = Object.entries(stockUrls).filter(([key]) => key.startsWith(job));
        let results = await Promise.allSettled(feeds.map(([key, url]) => fetchStockFeed(key, url, meta[key])));
        if (results.every(result => result.status === 'fulfilled' && result.value.status === 304)) {
          console.log(`stock:${job} 304 skip`);
          return;
        }
        // Any changed feed needs a complete market view; retain independent snapshot
        // updates on errors, but clear stale validators after a partial failure.
        results = await Promise.allSettled(results.map((result, i) => {
          if (result.status === 'rejected') return Promise.reject(result.reason);
          return result.value.status === 304 ? fetchStockFeed(feeds[i][0], feeds[i][1]) : result.value;
        }));
        const data = await buildStockSnapshot(job, async url => {
          const result = results[feeds.findIndex(([, feedUrl]) => feedUrl === url)];
          if (result.status !== 'fulfilled' || result.value.status !== 200) throw new Error('股票資料來源暫時無法使用');
          return result.value.body;
        });
        const succeeded = await Promise.all((['quotes', 'dividends'] as const).map(async (kind, i) => {
          const key = snapshotKeys[i], snapshot = data[kind];
          try {
            if (!snapshot) { console.warn(`${key} fail ${kind}: no snapshot`); return false; }
            if (kind === 'quotes' && snapshot.rows.length < minimumRows[job]) {
              console.warn(`${key} guard ${snapshot.rows.length} rows`);
              return false;
            }
            await write(key, snapshot);
            return true;
          } catch (error) { console.warn(`${key} fail ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`); return false; }
        }));
        if (!succeeded.every(Boolean)) {
          if (previous !== null) await env.SNAPSHOTS.delete(metaKeys[job]);
          return;
        }
        const next: StockMeta = {};
        for (const [i, result] of results.entries()) {
          if (result.status !== 'fulfilled' || result.value.status !== 200) {
            if (previous !== null) await env.SNAPSHOTS.delete(metaKeys[job]);
            return;
          }
          if (Object.keys(result.value.validators).length) next[feeds[i][0]] = result.value.validators;
        }
        const encoded = JSON.stringify(next);
        if (encoded !== JSON.stringify(decodeStockMeta(previous))) {
          if (Object.keys(next).length) await env.SNAPSHOTS.put(metaKeys[job], encoded);
          else await env.SNAPSHOTS.delete(metaKeys[job]);
        }
      } catch (error) { console.warn(`stock:${job} fail ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`); }
    }));
  },
};
