import { main } from './publish-garbage.js';
if (!process.argv.includes('--out')) { console.error('collect-garbage requires --out'); process.exitCode = 2; } else process.exitCode = await main();
