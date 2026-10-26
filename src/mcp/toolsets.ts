import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InvoiceServiceOptions } from '../core/invoice/service.js';
import { invoice } from './invoice.js';
export interface ToolsetContext extends InvoiceServiceOptions {
  log?: (msg: string) => void;
}
export interface Toolset {
  name: string;
  description: string;
  requiredEnv?: string[];
  register(server: McpServer, ctx: ToolsetContext): void;
}
export const toolsets: Toolset[] = [invoice];
export function registerToolsets(server: McpServer, selected: Toolset[], env: Record<string, string | undefined>, ctx: ToolsetContext = {}): void {
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
