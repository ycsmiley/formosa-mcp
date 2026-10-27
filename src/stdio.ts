#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createServer } from './mcp/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseToolsetsArg } from './mcp/cli.js';
import { toolsets } from './mcp/toolsets.js';
declare const __FORMOSA_VERSION__: string | undefined;
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`formosa-mcp — 讓 AI agent 懂台灣 / Taiwan MCP server
用法 / Usage: formosa-mcp [--toolsets invoice,stock]
預設啟用所有已實作工具集 / Default: all implemented toolsets
工具集 / Toolsets: invoice, stock
範例 / Examples:
  formosa-mcp --toolsets=invoice,stock
  formosa-mcp --toolsets invoice,stock
  formosa-mcp --help`);
} else {
  try {
    const selected = parseToolsetsArg(argv, toolsets.map(t => t.name));
    const version = typeof __FORMOSA_VERSION__ !== 'undefined' ? __FORMOSA_VERSION__ : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const server = createServer({ toolsets: selected, env: process.env, version });
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
