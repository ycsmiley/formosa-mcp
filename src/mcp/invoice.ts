import { z } from 'zod';
import { createInvoiceService, type InvoiceResult } from '../core/invoice/service.js';
import type { Toolset } from './toolsets.js';
const result = ({ text, isError }: InvoiceResult) => ({
  content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}),
});
export const invoice: Toolset = {
  name: 'invoice', description: '統一發票對獎 Taiwan uniform invoice lottery',
  register(server, ctx) {
    const service = createInvoiceService(ctx);
    server.registerTool('invoice_get_winning_numbers', {
      description: '查詢統一發票中獎號碼與領獎期間。Get Taiwan invoice winning numbers; omit period for the latest draw.',
      inputSchema: { period: z.string().optional() },
    }, async ({ period }) => result(await service.getWinningNumbers(period)));
    server.registerTool('invoice_check', {
      description: '統一發票對獎；未指定期別時檢查最新一期與仍可領獎的前一期。Check a Taiwan invoice number; 3–7 digits only check sixth prizes.',
      inputSchema: { number: z.string(), period: z.string().optional() },
    }, async ({ number, period }) => result(await service.check(number, period)));
  },
};
