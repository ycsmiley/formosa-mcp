import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCollector } from '../scripts/build-collectors.mjs';
it('committed outage publisher bundle equals a fresh build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outages-bundle-'));
  try {
    const output = join(dir, 'publish-outages.mjs'); await buildCollector('outages', output);
    expect((await readFile(output)).equals(await readFile('scripts/dist/publish-outages.mjs'))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('keeps collection pinned, off the hour, and on the existing KV write credentials', async () => {
  const workflow = await readFile('.github/workflows/outage-collect.yml', 'utf8');
  expect(workflow).toContain("cron: '23 22,4,10 * * *'"); expect(workflow).toContain('workflow_dispatch:'); expect(workflow).toContain('timeout-minutes: 5'); expect(workflow).toContain('group: outage-collect');
  expect(workflow).toContain('node-version: 22'); expect(workflow).toContain('persist-credentials: false'); expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
  expect(workflow).toContain('KV_NAMESPACE_ID: e92149e1efec4434835310d434b69f7d'); expect(workflow).toContain('vars.CLOUDFLARE_ACCOUNT_ID'); expect(workflow).toContain('secrets.CLOUDFLARE_KV_WRITE_TOKEN'); expect(workflow).toContain('node scripts/dist/publish-outages.mjs');
  for (const match of workflow.matchAll(/uses:\s*(\S+)/g)) expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
  expect(workflow).not.toContain('npm'); expect(workflow).not.toContain('TDX');
});
