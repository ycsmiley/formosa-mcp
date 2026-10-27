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
用法 / Usage: formosa-mcp [--toolsets invoice,stock,rail]
預設 / Default: invoice,stock
工具集 / Toolsets: invoice, stock, rail
rail 需 TDX 會員 API 金鑰 / Requires TDX_CLIENT_ID and TDX_CLIENT_SECRET
範例 / Examples:
  formosa-mcp --toolsets=invoice,stock
  formosa-mcp --toolsets invoice,stock
  formosa-mcp --toolsets rail
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
