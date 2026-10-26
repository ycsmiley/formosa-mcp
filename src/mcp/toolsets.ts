import type { z } from 'zod';
import type { StockSnapshotProvider } from '../core/stock/service.js';
import type { InvoiceServiceOptions } from '../core/invoice/service.js';
import { stock } from './stock.js';
import { invoice } from './invoice.js';
// Both SDK generations validate the raw Zod shape before invoking callbacks.
export interface ToolRegistrar {
  registerTool(name: string, config: { description: string; inputSchema: z.ZodRawShape }, cb: (args: any) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>): unknown;
}
export interface ToolsetContext extends InvoiceServiceOptions {
  snapshot?: StockSnapshotProvider;
  fetchJson?: (url: string) => Promise<unknown>;
  log?: (msg: string) => void;
}
export interface Toolset {
  name: string;
  description: string;
  requiredEnv?: string[];
  register(server: ToolRegistrar, ctx: ToolsetContext): void;
}
export const toolsets: Toolset[] = [invoice, stock];
export function registerToolsets(server: ToolRegistrar, selected: Toolset[], env: Record<string, string | undefined>, ctx: ToolsetContext = {}): void {
  const log = ctx.log ?? console.error;
  for (const toolset of selected) {
    const missing = toolset.requiredEnv?.filter(key => !env[key]);
    if (missing?.length) {
      log(`略過 ${toolset.name}：缺少環境變數 ${missing.join('、')}`);
      continue;
    }
    toolset.register(server, ctx);
  }
}
