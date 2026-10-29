import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const registryText = read('server.json');
const glamaText = read('glama.json');
const lhmText = read('lhm.plugin.json');
const registry = JSON.parse(registryText);
const glama = JSON.parse(glamaText);
const lhm = JSON.parse(lhmText);

it('keeps listing metadata consistent and excludes unpublished remote endpoints', () => {
  expect(registry.name).toBe('io.github.ycsmiley/formosa-mcp');
  expect(registry.name).toBe(pkg.mcpName);
  expect(registry.version).toBe(pkg.version);
  expect(registry.packages[0].version).toBe(pkg.version);
  expect(registry.packages[0].identifier).toBe(pkg.name);
  expect(registry.description.length).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(registryText)).toBeLessThan(4096);
  expect(registry).not.toHaveProperty('remotes');
  for (const text of [registryText, glamaText, lhmText]) {
    expect(text).not.toContain('workers.dev');
    expect(JSON.parse(text)).not.toHaveProperty('remotes');
  }
  expect(glama.maintainers).toContain('ycsmiley');
  expect(lhm.identifier).toMatch(/^[\da-z][\d_a-z-]*$/);
  expect(lhm.name).toBe(pkg.name);
  expect(lhm.version).toBe(pkg.version);
});

it('lists the default server tools in the LobeHub manifest', async () => {
  const server = createServer();
  const client = new Client({ name: 'listing-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    expect(lhm.tools).toEqual(tools);
  } finally {
    await client.close();
    await server.close();
  }
});

it('pins both Docker stages and runs stdio as node', () => {
  const dockerfile = read('Dockerfile');
  const from = dockerfile.split('\n').filter(line => /^FROM\s/i.test(line));
  expect(from).toHaveLength(2);
  for (const line of from) expect(line).toMatch(/^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/i);
  expect(dockerfile).toMatch(/^USER node$/m);
  expect(dockerfile).toMatch(/^ENTRYPOINT \["node",\s*"dist\/stdio\.js"\]$/m);
});
