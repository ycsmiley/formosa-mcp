import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCollector } from '../scripts/build-collectors.mjs';

it('committed garbage publisher bundle equals a fresh build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'garbage-bundle-'));
  try {
    const output = join(dir, 'publish-garbage.mjs');
    await buildCollector('garbage', output);
    expect((await readFile(output)).equals(await readFile('scripts/dist/publish-garbage.mjs'))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
