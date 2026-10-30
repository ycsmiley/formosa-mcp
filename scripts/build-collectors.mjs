import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function buildCollector(name, outfile = `scripts/dist/publish-${name}.mjs`) {
  await build({ entryPoints: [`scripts/publish-${name}.ts`], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const name of ['tpex', 'rail', 'garbage']) await buildCollector(name, process.argv[2] ? `${process.argv[2]}/publish-${name}.mjs` : undefined);
}
