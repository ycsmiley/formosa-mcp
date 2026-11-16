import { z } from 'zod';
import { createFuelService } from '../core/fuel/service.js';
import type { Toolset } from './toolsets.js';
export const fuel: Toolset = {
  name: 'fuel', description: '中油油價 CPC fuel list prices',
  register(server, ctx) {
    const service = createFuelService(ctx);
    server.registerTool('fuel_price', { description: '查詢台灣中油汽柴油與燃料油牌價、生效日；只有中油，不含台塑石化，實際站售價格可能不同。', inputSchema: { product: z.string().max(30).optional().describe('產品關鍵字，例如 95、柴油、燃料油；預設汽柴油零售') } }, async args => {
      const r = await service.query(args.product); return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    });
  },
};
