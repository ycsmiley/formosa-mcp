// Offline developer demo: real stdio for missing keys; in-process injection for fixtures.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { fixtureHttp } from './rail-fixtures.js';

const calls = [
  ['thsr_timetable', { origin: '北車', destination: '高雄', date: '2026-10-28', time: '22:00' }],
  ['tra_timetable', { origin: '臺北', destination: '高雄', date: '2026-10-28', time: '00:00' }],
  ['tra_live', { train_no: '123' }],
  ['tra_live', { station: '臺北' }],
] as const;
async function show(client: Client, missing: boolean) {
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['thsr_timetable', 'tra_timetable', 'tra_live']);
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, missing);
    const text = (result.content as { text: string }[]).map(c => c.text).join('\n');
    assert.ok(missing ? text.includes('需要 TDX 會員 API 金鑰') : text.endsWith('資料介接「交通部TDX平臺」'));
    console.log(`\n${name}\n${text}`);
  }
}

// Explicitly pass empty keys, even if the developer's parent environment has them.
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url)), '--toolsets', 'rail'], env: { TDX_CLIENT_ID: '', TDX_CLIENT_SECRET: '' } });
const stdio = new Client({ name: 'rail-demo-stdio', version: '1' });
try {
  console.log('缺少金鑰：實際 stdio server（不連線 TDX）');
  await stdio.connect(transport); await show(stdio, true);
} finally { await stdio.close(); await transport.close(); }

const server = createServer({ toolsets: ['rail'], env: { TDX_CLIENT_ID: 'fixture-only', TDX_CLIENT_SECRET: 'fixture-only' }, railHttp: fixtureHttp, clock: () => new Date('2026-10-27T16:30:00Z') });
const client = new Client({ name: 'rail-demo-fixtures', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  console.log('\n離線合成資料：in-process MCP client（非即時資料）');
  await server.connect(a); await client.connect(b); await show(client, false);
} finally { await client.close(); await server.close(); }
