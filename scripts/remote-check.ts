import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const url = new URL(process.env.REMOTE_URL ?? 'http://localhost:8787/mcp');
const client = new Client({ name: 'remote-check', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(url));
  console.log('工具：', (await client.listTools()).tools.map(t => t.name).join(', '));
  for (const [name, args] of [ ['stock_quote', { query: '2330' }], ['stock_quote', { query: '6488' }], ['stock_dividends', {}], ['invoice_get_winning_numbers', {}], ['invoice_check', { number: '54348835' }] ] as const) {
    console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    console.log(text);
    if (result.isError || /undefined|null|NaN|\[object/.test(text)) throw new Error(`${name} failed`);
    if (name === 'stock_quote' && !text.includes(`（${args.query}）`)) throw new Error(`Missing stock ${args.query}`);
  }
} finally { await client.close(); }
if (process.argv.includes('--burst')) {
  for (let i = 0; i < 65; i++) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }) });
    if (response.status === 429) { console.log(response.status, await response.text()); break; }
    await response.text();
    if (i === 64) throw new Error('No 429 received');
  }
}
const missing = await fetch(new URL('/nope', url)); console.log(missing.status, await missing.text());
if (missing.status !== 404) throw new Error('Expected 404');
