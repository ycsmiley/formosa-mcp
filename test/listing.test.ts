import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

it('restricts npm contents and keeps publishing metadata and lifecycle scripts safe', () => {
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    expect(pkg.scripts).not.toHaveProperty(script);
  }
  expect(pkg.scripts.prepublishOnly).toBe('npm run clean && npm run build && npm test');
  expect(pkg.files).toEqual(['dist/**/*.js', 'dist/**/*.d.ts']);
  for (const entry of pkg.files) {
    expect(entry).not.toMatch(/src|test|scripts|evals|plugin|wrangler|\.env|\.map/);
  }
  expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/ycsmiley/formosa-mcp.git' });
  expect(pkg.homepage).toBe('https://github.com/ycsmiley/formosa-mcp#readme');
  expect(pkg.bugs).toEqual({ url: 'https://github.com/ycsmiley/formosa-mcp/issues' });
  expect(pkg.keywords).toEqual(expect.arrayContaining(['taiwan', 'mcp', 'invoice', 'twse', 'tpex']));
  expect(pkg.publishConfig).toEqual({ access: 'public' });
});

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

it('marks rail as in development in listing descriptions when no rail tools are listed', () => {
  if (lhm.tools.some(({ name }: { name: string }) => /^(thsr_|tra_|rail)/i.test(name))) return;

  for (const listing of [lhm, glama, registry]) {
    const descriptions = [listing.description, ...(listing.localizations ?? []).map((localization: { description?: string }) => localization.description)];
    for (const description of descriptions) {
      if (typeof description === 'string' && /rail|台鐵|高鐵|timetable/i.test(description)) {
        expect(description).toMatch(/in development|開發中/i);
      }
    }
    expect(listing.tags ?? []).not.toContain('rail');
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


it('never prints the unpublished remote host', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
  const paths = ['README.md', 'README.en.md', 'plugin/server/formosa-mcp.mjs', 'server.json'].map(path => join(root, path));
  paths.push(...filesUnder(join(root, 'src')));
  if (existsSync(join(root, 'dist'))) paths.push(...filesUnder(join(root, 'dist')));
  for (const path of paths) expect(readFileSync(path, 'utf8').includes('workers.dev'), path).toBe(false);

  const zh = read('README.md');
  const en = read('README.en.md');
  expect(zh).toContain('**繁體中文** · [English](README.en.md)');
  expect(en).toContain('[繁體中文](README.md) · **English**');
  for (const [name, content] of [['README.md', zh], ['README.en.md', en]]) {
    const allowedSentence = 'A keyless public URL is coming soon; you will be able to paste it into a Claude custom connector.';
    expect(content.replace(allowedSentence, ''), name).not.toMatch(/存取權限|access required|即將公開|coming soon/i);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
      expect(existsSync(resolve(dirname(join(root, name)), target)), `${name}: ${target}`).toBe(true);
    }
  }
});
