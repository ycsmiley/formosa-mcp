import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ServerOptions } from '../src/mcp/server.js';
import { createServer } from '../src/mcp/server.js';
import { toolsets } from '../src/mcp/toolsets.js';
import { fixtureHttp } from '../scripts/rail-fixtures.js';
import { fixtureData } from './output-contract-fixtures.js';
import { contractSuite, type Reply } from './output-contract-helper.js';
const fresh = fixtureData(), stale = fixtureData(true);
async function withClient<T>(old: boolean, run: (client: Client) => Promise<T>, overrides: ServerOptions = {}) {
  const { options, liveTrain } = await (old ? stale : fresh);
  const server = createServer({ ...options, ...overrides, toolsets: toolsets.map(t => t.name), env: { TDX_CLIENT_ID: 'fixture', TDX_CLIENT_SECRET: 'fixture' },
    railHttp: (url, init) => url.includes('/TrainLiveBoard/TrainNo/2037')
      ? Promise.resolve({ status: 200, json: async () => liveTrain }) : fixtureHttp(url, init) });
  const client = new Client({ name: 'output-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(a); await client.connect(b); return await run(client); }
  finally { await client.close(); await server.close(); }
}
contractSuite('local', {
  sourceFailure: () => withClient(false, async c => await c.callTool({ name: 'fuel_price', arguments: {} }) as Reply, { fetchFuel: async () => { throw Error('offline'); } }),
  listTools: () => withClient(false, async c => (await c.listTools()).tools.map(t => t.name)),
  call: (name, args, old = false) => withClient(old, async c => await c.callTool({ name, arguments: args }) as Reply),
});
