import { expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseToolsetsArg } from '../src/mcp/cli.js';
import { registerToolsets } from '../src/mcp/toolsets.js';
it('defaults to all', () => expect(parseToolsetsArg([], ['invoice', 'other'])).toEqual(['invoice', 'other']));
it.each([['--toolsets=invoice'], ['--toolsets', 'invoice']])('parses %j', (...argv) => expect(parseToolsetsArg(argv, ['invoice'])).toEqual(['invoice']));
it('supports comma-separated toolsets', () => expect(parseToolsetsArg(['--toolsets=invoice,other'], ['invoice', 'other'])).toEqual(['invoice', 'other']));
it.each([['--toolsets=foo'], ['--toolsets'], ['--toolsets=']])('rejects unknown or missing names %j', (...argv) => expect(() => parseToolsetsArg(argv, ['invoice'])).toThrow(/有效工具集：invoice/));
it('skips toolsets with missing environment variables', () => {
  const register = vi.fn();
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    registerToolsets(new McpServer({ name: 'test', version: '1' }), [{ name: 'keyed', description: '', requiredEnv: ['KEY'], register }], {});
    expect(register).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('略過 keyed：缺少環境變數 KEY');
    registerToolsets(new McpServer({ name: 'test', version: '1' }), [{ name: 'keyed', description: '', requiredEnv: ['KEY'], register }], { KEY: 'value' });
    expect(register).toHaveBeenCalledTimes(1);
  } finally { stderr.mockRestore(); }
});

it('rail requires explicit CLI opt-in while invoice and stock stay default', () => {
  expect(parseToolsetsArg([], ['invoice', 'stock', 'rail'])).toEqual(['invoice', 'stock']);
  expect(parseToolsetsArg(['--toolsets', 'rail'], ['invoice', 'stock', 'rail'])).toEqual(['rail']);
  expect(parseToolsetsArg(['--toolsets=invoice,stock,rail'], ['invoice', 'stock', 'rail'])).toEqual(['invoice', 'stock', 'rail']);
});
