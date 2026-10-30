import { localGarbageStore } from '../garbage/store.js';
import type { GarbageStore } from '../core/garbage/service.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RailHttp } from '../core/rail/client.js';
import type { Clock } from '../core/clock.js';
import { registerToolsets, toolsets } from './toolsets.js';
export interface ServerOptions {
  garbageStore?: GarbageStore;
  toolsets?: string[];
  env?: Record<string, string | undefined>;
  version?: string;
  clock?: Clock;
  railHttp?: RailHttp;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchFeed?: () => Promise<string>;
  log?: (msg: string) => void;
}
export function createServer(options: ServerOptions = {}): McpServer {
  const available = toolsets.map(t => t.name);
  const selected = options.toolsets ?? ['invoice', 'stock', 'garbage'];
  for (const name of selected) {
    if (!available.includes(name)) throw new Error(`未知工具集「${name}」。有效工具集：${available.join(', ')}`);
  }
  const server = new McpServer({ name: 'formosa-mcp', version: options.version ?? '0.1.0' });
  registerToolsets(server, toolsets.filter(t => selected.includes(t.name)), options.env ?? {}, { ...options, garbageStore: options.garbageStore ?? localGarbageStore(options.env?.FORMOSA_GARBAGE_DIR) });
  return server;
}
