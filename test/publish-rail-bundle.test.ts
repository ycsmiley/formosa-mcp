import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCollector } from '../scripts/build-collectors.mjs';

it('committed rail publisher bundle equals a fresh build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rail-bundle-'));
  try {
    const output = join(dir, 'publish-rail.mjs');
    await buildCollector('rail', output);
    expect((await readFile(output)).equals(await readFile('scripts/dist/publish-rail.mjs'))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
