import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directoryStore, kvStore, type Store } from './snapshot-store.js';
import { decodeFuel, fuelKey, validTime, type FuelSnapshot } from '../src/core/fuel/model.js';
import { parseFuel } from '../src/core/fuel/parse.js';
import { fetchFuel, fuelReason } from '../src/core/fuel/source.js';
export interface FuelPublisherOptions { store: Store; fetchFuel?: () => Promise<unknown>; now?: () => Date; sleep?: (ms: number) => Promise<void>; dryRun?: boolean; log?: (s: string) => void }
export async function publishFuel(options: FuelPublisherOptions) {
  const fetcher = options.fetchFuel ?? fetchFuel, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let body: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { body = await fetcher(); break; }
    catch (e) { if (attempt === 2) throw e; await sleep((attempt + 1) * 1000); }
  }
  const items = parseFuel(body), time = (options.now ?? (() => new Date()))().toISOString();
  const raw = await options.store.get(fuelKey);
  let previous = decodeFuel(raw), invalidCheck = false;
  // Repair a legacy/malformed heartbeat while retaining valid content-change time.
  if (!previous && raw) {
    try {
      const old = JSON.parse(raw);
      if (!validTime(old.checkedAt)) { previous = decodeFuel({ ...old, checkedAt: time }); invalidCheck = true; }
    } catch { /* corrupt snapshots are replaced only after a validated fetch */ }
  }
  const changed = !previous || JSON.stringify(items) !== JSON.stringify(previous.items);
  const heartbeat = !changed && (invalidCheck || Date.parse(time) - Date.parse(previous!.checkedAt) >= 20 * 3600000);
  const payload: FuelSnapshot = { v: 1, items, changedAt: changed ? time : previous!.changedAt, checkedAt: changed || heartbeat ? time : previous!.checkedAt };
  const decision = changed ? 'changed' : heartbeat ? 'heartbeat' : 'skip';
  let writes = 0;
  if (options.dryRun) {
    (options.log ?? console.log)(decision === 'skip' ? 'skip' : `would write (${decision})`);
    (options.log ?? console.log)(JSON.stringify(payload));
  } else if (decision !== 'skip') {
    // At most one write per run; two scheduled runs cost at most two writes/day.
    await options.store.put(fuelKey, JSON.stringify(payload), time); writes = 1;
  }
  return { writes, decision, payload };
}
export async function main(args = process.argv.slice(2), env: Record<string, string | undefined> = process.env, overrides: Partial<FuelPublisherOptions> = {}): Promise<number> {
  let dryRun = false, out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run' && !dryRun) dryRun = true;
    else if (args[i] === '--out' && !out && args[i + 1]?.trim() && !args[i + 1].startsWith('--')) out = args[++i];
    else { console.error('Usage: publish-fuel [--dry-run] [--out dir]'); return 2; }
  }
  if (!dryRun && !out && ['CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID', 'CLOUDFLARE_KV_WRITE_TOKEN'].some(k => !env[k]?.trim())) { console.error('fuel KV configuration missing'); return 2; }
  const store = out ? directoryStore(out) : dryRun ? { get: async () => null, put: async () => { throw Error('dry-run must never write'); } } : kvStore(env);
  try {
    const result = await publishFuel({ ...overrides, store: overrides.store ?? store, dryRun });
    console.log(`fuel KV writes=${result.writes}`); return 0;
  } catch (e) {
    // Never log arbitrary exception messages: they can contain URLs or tokens.
    console.warn(`::warning::fuel collection failed: ${fuelReason(e)}`);
    console.log('fuel KV writes=0'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
