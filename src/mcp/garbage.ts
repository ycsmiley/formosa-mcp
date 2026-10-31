import { z } from 'zod';
import { createGarbageService } from '../core/garbage/service.js';
import type { Toolset } from './toolsets.js';
export const garbage: Toolset = {
  name: 'garbage', description: '垃圾車收運時刻 Garbage collection schedules',
  register(server, ctx) {
    const service = createGarbageService(ctx.garbageStore ?? { index: async () => null, shard: async () => null }, ctx.clock);
    server.registerTool('garbage_schedule', { description: '查詢新北市、臺北市、臺中市垃圾車定點收運時刻。', inputSchema: {
      city: z.string().min(1).max(30).describe('城市名稱'), district: z.string().max(30).optional().describe('行政區；關鍵字包含行政區時可省略'), keyword: z.string().max(100).optional().describe('里、路名或地點'), weekday: z.string().max(10).optional().describe('今天、明天或週一至週日'), time: z.string().max(10).optional().describe('HH:MM，只顯示此時間及之後的收運點'),
    } }, async args => { const result = await service.schedule(args); return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }; });
  },
};
