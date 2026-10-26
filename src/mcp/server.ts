import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Clock } from '../core/clock.js';
import { registerToolsets, toolsets } from './toolsets.js';
export interface ServerOptions {
  toolsets?: string[];
  env?: Record<string, string | undefined>;
  version?: string;
  clock?: Clock;
  fetchFeed?: () => Promise<string>;
  log?: (msg: string) => void;
}
export function createServer(options: ServerOptions = {}): McpServer {
  const available = toolsets.map(t => t.name);
  const selected = options.toolsets ?? available;
  for (const name of selected) {
    if (!available.includes(name)) throw new Error(`未知工具集「${name}」。有效工具集：${available.join(', ')}`);
  }
  const server = new McpServer({ name: 'formosa-mcp', version: options.version ?? '0.1.0' });
  registerToolsets(server, toolsets.filter(t => selected.includes(t.name)), options.env ?? {}, options);
  return server;
}
