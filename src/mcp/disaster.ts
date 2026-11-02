import { z } from 'zod';
import { createDisasterService } from '../core/disaster/service.js';
import type { Toolset } from './toolsets.js';
export const disaster: Toolset = {
  name: 'disaster', description: '停班停課與災防告警',
  register(server, ctx) {
    const service = createDisasterService(ctx.disasterStore ?? { indexes: async () => ({ worker: null, gha: null }), shard: async () => null }, ctx.clock);
    for (const [name, method, description] of [
      ['work_school_closure', 'closure', '查詢縣市今天與明天的天然災害停班停課官方公告。'],
      ['disaster_alerts', 'alerts', '查詢縣市生效中的 NCDR 災防告警，含地震、停水與颱風。'],
    ] as const) server.registerTool(name, { description, inputSchema: { city: z.string().min(1).max(30).describe('縣市名稱；新竹、嘉義會列出市與縣') } }, async args => { const result = await service[method](args); return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }; });
  },
};
