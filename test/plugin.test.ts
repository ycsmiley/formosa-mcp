import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { json, pluginClient, pluginRoot, root } from '../scripts/plugin-client.js';

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
it('validates plugin, marketplace, and skill metadata and references', () => {
  const plugin = json('plugin/.claude-plugin/plugin.json');
  const marketplace = json('.claude-plugin/marketplace.json');
  const mcp = json('plugin/.mcp.json');
  expect(plugin.name).toMatch(kebab);
  expect(plugin.version).toBe(json('package.json').version);
  for (const field of ['description', 'license', 'repository']) expect(plugin[field]).toBeTruthy();
  expect(plugin.author.name).toBeTruthy();
  expect(marketplace.name).toMatch(kebab);
  expect(marketplace.owner.name).toBeTruthy();
  expect(marketplace.plugins.length).toBeGreaterThan(0);
  for (const entry of marketplace.plugins) {
    expect(entry.name).toBe(plugin.name);
    expect(entry.description).toBeTruthy();
    expect(entry.source).toMatch(/^\.\//);
    expect(entry.source.split('/')).not.toContain('..');
    expect(resolve(root, entry.source)).toBe(pluginRoot);
    expect(existsSync(resolve(root, entry.source))).toBe(true);
  }
  expect(mcp.mcpServers.formosa.command).toBeTruthy();
  expect(mcp.mcpServers.formosa.args).toContain('${CLAUDE_PLUGIN_ROOT}/server/formosa-mcp.mjs');
  const dir = join(pluginRoot, 'skills/formosa-taiwan');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
  expect(match).not.toBeNull();
  const name = /^name: (.+)$/m.exec(match![1])?.[1] ?? '';
  const description = /^description: (.+)$/m.exec(match![1])?.[1] ?? '';
  expect(name).toMatch(kebab); expect(name.length).toBeLessThanOrEqual(64); expect(name).toBe(basename(dir));
  expect(description.length).toBeGreaterThan(0); expect(description.length).toBeLessThanOrEqual(1024);
  expect(match![2].split('\n').length).toBeLessThan(500);
  const refs = [...match![2].matchAll(/\]\(([^)]+)\)/g)];
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) { expect(ref[1]).toMatch(/^references\/[^/]+\.md$/); expect(existsSync(join(dir, ref[1]))).toBe(true); }
});
it('launches configured server from another cwd and lists both toolsets', async () => {
  const { client, transport } = pluginClient();
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['invoice_get_winning_numbers', 'invoice_check', 'stock_quote', 'stock_market_summary', 'stock_dividends']);
  } finally { await client.close(); await transport.close(); }
});
it('committed plugin bundle matches a fresh build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'formosa-bundle-'));
  try {
    const output = join(dir, 'server.mjs');
    execFileSync(process.execPath, ['scripts/build-plugin.mjs', output], { cwd: root });
    expect(readFileSync(output).equals(readFileSync(join(pluginRoot, 'server/formosa-mcp.mjs')))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
