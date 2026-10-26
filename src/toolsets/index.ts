import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import invoice from './invoice/index.js';
export interface Toolset {
  name: string;
  description: string;
  requiredEnv?: string[];
  register(server: McpServer): void;
}
export const toolsets: Toolset[] = [invoice];
export function registerToolsets(server: McpServer, selected: Toolset[], env: NodeJS.ProcessEnv = process.env): void {
  for (const toolset of selected) {
    const missing = toolset.requiredEnv?.filter(key => !env[key]);
    if (missing?.length) {
      console.error(`略過 ${toolset.name}：缺少環境變數 ${missing.join('、')}`);
      continue;
    }
    toolset.register(server);
  }
}
