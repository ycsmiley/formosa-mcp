import { z } from 'zod';
import { createStockService, type StockResult } from '../core/stock/service.js';
import type { Toolset } from './toolsets.js';
const result = ({ text, isError }: StockResult) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
export const stock: Toolset = {
  name: 'stock', description: '台股盤後行情與除權息 Taiwan stocks (TWSE+TPEx, end-of-day)',
  register(server, ctx) {
    const service = createStockService({ snapshot: ctx.snapshot, fetchJson: ctx.fetchJson, fetchMarketFeed: ctx.fetchMarketFeed, clock: ctx.clock });
    server.registerTool('stock_quote', {
      description: '以股票代號或名稱查詢上市／上櫃盤後行情、本益比與殖利率，非即時。Taiwan TWSE/TPEx end-of-day quote by code or name, not real-time.',
      inputSchema: { query: z.string() },
    }, async ({ query }) => result(await service.quote(query)));
    server.registerTool('stock_market_summary', {
      description: '查詢上市加權指數、上櫃指數收盤漲跌、成交金額與融資券餘額（張）。兩市場各有資料日期，盤後資料，非即時；無需參數。Taiwan market closing summary, separately dated TWSE and TPEx; not real-time.',
      inputSchema: {},
    }, async () => result(await service.marketSummary()));
    server.registerTool('stock_dividends', {
      description: '查詢上市／上櫃近期除權息日程，可指定股票代號或名稱。Upcoming Taiwan TWSE/TPEx ex-dividend and ex-right dates; optional code or name.',
      inputSchema: { query: z.string().optional() },
    }, async ({ query }) => result(await service.dividends(query)));
  },
};
