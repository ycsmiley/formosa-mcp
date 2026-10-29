import { build } from 'esbuild';
await build({ entryPoints: ['scripts/publish-tpex.ts'], outfile: process.argv[2] ?? 'scripts/dist/publish-tpex.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node20' });
