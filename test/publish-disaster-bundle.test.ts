import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCollector } from '../scripts/build-collectors.mjs';
it('bundles disaster independently of other publisher entrypoints (operator regenerates committed dist)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disaster-bundle-'));
  try {
    const output = join(dir, 'publish-disaster.mjs'); await buildCollector('disaster', output); const text = await readFile(output, 'utf8');
    expect(text).toContain('Usage: publish-disaster'); expect(text).not.toContain('Usage: publish-outages'); expect(text).toContain('expiration_ttl=');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('uses hourly staggered GHA, existing secret and namespace, pinned Node 22, and committed bundle only', async () => {
  const workflow = await readFile('.github/workflows/disaster-collect.yml', 'utf8');
  for (const value of ["cron: '20 * * * *'", 'workflow_dispatch:', 'group: disaster-collect', 'timeout-minutes: 10', 'node-version: 22', 'vars.CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID: e92149e1efec4434835310d434b69f7d', 'node scripts/dist/publish-disaster.mjs']) expect(workflow).toContain(value);
  expect([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1])).toEqual(['CLOUDFLARE_KV_WRITE_TOKEN']);
  expect(workflow).not.toContain('npm '); expect(await readFile('plugin/.mcp.json', 'utf8')).toContain('invoice,stock');
});
