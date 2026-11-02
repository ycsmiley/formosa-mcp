import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCollector } from '../scripts/build-collectors.mjs';

it('bundles garbage independently (operator regenerates committed dist)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'garbage-bundle-'));
  try {
    const output = join(dir, 'publish-garbage.mjs');
    await buildCollector('garbage', output);
    const text = await readFile(output, 'utf8');
    expect(text).toContain('Usage: publish-garbage'); expect(text).toContain('expiration_ttl=');
    expect(text).not.toContain('Usage: publish-disaster');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
