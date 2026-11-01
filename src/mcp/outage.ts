import { z } from 'zod';
import { createOutageService } from '../core/outage/service.js';
import type { Toolset } from './toolsets.js';
export const outage: Toolset = {
  name: 'outage', description: '計畫性停水停電 Planned water and power outages',
  register(server, ctx) {
    const service = createOutageService(ctx.outageStore ?? { index: async () => null, shard: async () => null }, ctx.clock);
    server.registerTool('outage_schedule', { description: '查詢計畫性停水、停電公告；緊急搶修、事故、颱風造成的停水停電不會事先公告。Planned water/power outages only.', inputSchema: {
      city: z.string().min(1).max(30).describe('縣市名稱'), district: z.string().max(30).optional().describe('行政區名稱'), keyword: z.string().max(100).optional().describe('路名或地區關鍵字'), type: z.enum(['water', 'power', 'all']).default('all').describe('停水、停電或全部'), start_date: z.string().max(10).optional().describe('起日 YYYY-MM-DD，預設臺北時間今天'), end_date: z.string().max(10).optional().describe('迄日 YYYY-MM-DD，預設今天加六天；最多 31 天'),
    } }, async args => { const result = await service.schedule(args); return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }; });
  },
};
