import { main } from './publish-outages.js';
if (!process.argv.includes('--out')) { console.error('collect-outages requires --out'); process.exitCode = 2; } else process.exitCode = await main();
