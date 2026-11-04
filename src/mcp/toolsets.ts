import { disaster } from './disaster.js';
import type { DisasterStore } from '../core/disaster/service.js';
import { outage } from './outage.js';
import type { OutageStore } from '../core/outage/service.js';
import { garbage } from './garbage.js';
import type { GarbageStore } from '../core/garbage/service.js';
import type { z } from 'zod';
import type { MarketFeed } from '../core/stock/source.js';
import type { StockSnapshotProvider } from '../core/stock/service.js';
import type { InvoiceServiceOptions } from '../core/invoice/service.js';
import { stock } from './stock.js';
import type { createRailService } from '../core/rail/service.js';
import type { RailHttp } from '../core/rail/client.js';
import { rail } from './rail.js';
import { invoice } from './invoice.js';
// Both SDK generations validate the raw Zod shape before invoking callbacks.
export interface ToolRegistrar {
  registerTool(name: string, config: { description: string; inputSchema: z.ZodRawShape }, cb: (args: any) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>): unknown;
}
export interface ToolsetContext extends InvoiceServiceOptions {
  garbageStore?: GarbageStore;
  outageStore?: OutageStore;
  disasterStore?: DisasterStore;
  env?: Record<string, string | undefined>;
  railHttp?: RailHttp;
  railService?: ReturnType<typeof createRailService>;
  snapshot?: StockSnapshotProvider;
  fetchMarketFeed?: (url: string) => Promise<MarketFeed>;
  fetchJson?: (url: string) => Promise<unknown>;
  log?: (msg: string) => void;
}
export interface Toolset {
  name: string;
  description: string;
  requiredEnv?: string[];
  register(server: ToolRegistrar, ctx: ToolsetContext): void;
}
export const DEFAULT_TOOLSETS = ['invoice', 'stock', 'garbage', 'outage'];
export const toolsets: Toolset[] = [invoice, stock, garbage, outage, disaster, rail];
export function registerToolsets(server: ToolRegistrar, selected: Toolset[], env: Record<string, string | undefined>, ctx: ToolsetContext = {}): void {
  const log = ctx.log ?? console.error;
  for (const toolset of selected) {
    const missing = toolset.requiredEnv?.filter(key => !env[key]);
    if (missing?.length) {
      log(`略過 ${toolset.name}：缺少環境變數 ${missing.join('、')}`);
      continue;
    }
    toolset.register(server, { ...ctx, env });
  }
}
