#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseToolsetsArg } from './cli.js';
import { registerToolsets, toolsets } from './toolsets/index.js';
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`formosa-mcp — 讓 AI agent 懂台灣 / Taiwan MCP server
用法 / Usage: formosa-mcp [--toolsets invoice]
預設啟用所有已實作工具集 / Default: all implemented toolsets
工具集 / Toolsets: invoice
範例 / Examples:
  formosa-mcp --toolsets=invoice
  formosa-mcp --toolsets invoice
  formosa-mcp --help`);
} else {
  try {
    const selected = parseToolsetsArg(argv, toolsets.map(t => t.name));
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const server = new McpServer({ name: 'formosa-mcp', version });
    registerToolsets(server, toolsets.filter(t => selected.includes(t.name)));
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
