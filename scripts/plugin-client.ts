import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const pluginRoot = fileURLToPath(new URL('../plugin', import.meta.url));
export const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
export function pluginClient() {
  const config = json('plugin/.mcp.json').mcpServers.formosa as { command: string; args: string[] };
  const resolve = (s: string) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  const transport = new StdioClientTransport({ command: resolve(config.command), args: config.args.map(resolve), cwd: tmpdir() });
  const client = new Client({ name: 'formosa-plugin-check', version: '1.0.0' });
  return { client, transport };
}
