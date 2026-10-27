import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await build({ entryPoints: ['src/stdio.ts'], outfile: process.argv[2] ?? 'plugin/server/formosa-mcp.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true, define: { __FORMOSA_VERSION__: JSON.stringify(version) }, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
