#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createServer } from './mcp/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseToolsetsArg } from './mcp/cli.js';
import { DEFAULT_TOOLSETS, toolsets } from './mcp/toolsets.js';
declare const __FORMOSA_VERSION__: string | undefined;
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`formosa-mcp — 讓 AI agent 懂台灣 / Taiwan MCP server
用法 / Usage: formosa-mcp [--toolsets invoice,stock,garbage,outage,disaster,rail,calendar,fuel]
預設 / Default: ${DEFAULT_TOOLSETS.join(',')}
工具集 / Toolsets: invoice, stock, garbage, outage, disaster（實驗中、預設關閉 / experimental, off by default）, rail, calendar, fuel
fuel_price：只有台灣中油牌價，不含台塑石化；本機抓取 openData，遠端讀 Actions KV 快照 / CPC only, no Formosa; local openData, remote Actions KV
rail 查詢需自己的免費 TDX 金鑰；缺金鑰時顯示設定指引 / Queries require TDX_CLIENT_ID and TDX_CLIENT_SECRET; missing keys show setup guidance
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
