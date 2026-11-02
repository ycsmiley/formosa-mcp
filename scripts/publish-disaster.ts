import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directoryStore, kvStore } from './snapshot-store.js';
import { collectDisaster, reason, type Store } from '../src/core/disaster/collect.js';
import { fetchText } from '../src/core/disaster/http.js';
import { decodeIndex, indexKey } from '../src/core/disaster/model.js';
export async function main(args = process.argv.slice(2), env = process.env): Promise<number> {
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1]?.trim())) { console.error('Usage: publish-disaster [--out dir]'); return 2; }
  if (!args[1] && ['CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID', 'CLOUDFLARE_KV_WRITE_TOKEN'].some(k => !env[k]?.trim())) { console.error('disaster KV configuration missing'); return 2; }
  const backing = args[1] ? directoryStore(args[1]) : kvStore(env);
  const store: Store = { get: key => backing.get(key), put: (key, value, ttl) => backing.put(key, value, new Date().toISOString(), ttl) };
  try {
    const result = await collectDisaster({ writer: 'gha', store, token: env.CLOUDFLARE_KV_WRITE_TOKEN, fetchText: url => fetchText(url, 30000), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), maxCaps: 20, quietWindow: true, peerIndex: async () => { const raw = await store.get(indexKey('worker')); return raw ? decodeIndex(raw) : null; } });
    for (const [source, state] of Object.entries(result.index.sources)) {
      const message = `disaster ${source} ok=${state.ok} skipped=${!!state.skipped} count=${state.count ?? 0}${state.reason ? ` reason=${reason(state.reason, env.CLOUDFLARE_KV_WRITE_TOKEN)}` : ''}`;
      if (!state.ok && !state.skipped) console.warn(message); else console.log(message);
    }
    console.log(`disaster KV writes=${result.writes}`); return result.exitCode;
  } catch (e) { console.error(`disaster publication failed: ${reason(e, env.CLOUDFLARE_KV_WRITE_TOKEN)}`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
