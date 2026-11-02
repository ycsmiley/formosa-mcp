import { main } from './publish-disaster.js';
if (!process.argv.includes('--out')) { console.error('collect-disaster requires --out'); process.exitCode = 2; } else process.exitCode = await main();
