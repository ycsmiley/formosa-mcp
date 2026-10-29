import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeQuotesSnapshot, decodeSnapshot } from '../src/core/snapshot.js';
import { keys } from '../src/worker/snapshot-keys.js';
import { collectTpex, type TpexManifest } from './collect-tpex.js';

const requiredEnv = ['CLOUDFLARE_ACCOUNT_ID', 'KV_NAMESPACE_ID', 'CLOUDFLARE_KV_WRITE_TOKEN'] as const;
const tpexKeys = [keys.tpexQuotes, keys.tpexDividends];
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export async function publishTpex({ outDir, env = process.env, now = new Date() }: {
  outDir?: string; env?: Record<string, string | undefined>; now?: Date;
} = {}): Promise<number> {
  const missing = requiredEnv.filter(name => !env[name]);
  if (missing.length) { console.error(missing.join('\n')); return 2; }
  const token = env.CLOUDFLARE_KV_WRITE_TOKEN!;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE_ID}`;
  const request = (key: string, init: RequestInit = {}) => fetch(`${base}/values/${encodeURIComponent(key)}`, {
    ...init, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'manual',
  });
  let previousDir: string | undefined;
  try {
    previousDir = await mkdtemp(join(tmpdir(), 'tpex-previous-'));
    const previous: TpexManifest = { v: 1, market: 'tpex', generatedAt: now.toISOString(), written: [], failures: [], keys: {} };
    for (const key of tpexKeys) {
      let response: Response;
      try { response = await request(key); }
      catch { console.error(`kv read ${key} failed`); return 1; }
      if (response.status === 404) continue;
      if (response.status !== 200) { console.error(`kv read ${key} HTTP ${response.status}`); return 1; }
      const value = await response.text();
      let rows: number, dataDate: string | null = null;
      try {
        if (key === keys.tpexQuotes) {
          const snapshot = decodeQuotesSnapshot(value);
          rows = snapshot.rows.length;
          dataDate = snapshot.rows.map(({ date }) => {
            const { year, month, day } = date;
            if (![year, month, day].every(Number.isInteger)) throw new Error('invalid date');
            return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          }).sort().at(-1) ?? null;
          if (!dataDate) throw new Error('missing date');
        } else {
          const snapshot = decodeSnapshot<{ rows: unknown[] }>(value);
          if (!Array.isArray(snapshot.rows)) throw new Error('missing rows');
          rows = snapshot.rows.length;
        }
      } catch { console.warn(`kv read ${key} invalid snapshot; treating as absent`); continue; }
      const file = `${key.replaceAll(':', '_')}.json`;
      await writeFile(join(previousDir, file), value, 'utf8');
      previous.keys[key] = { file, dataDate, rows, bytes: new TextEncoder().encode(value).length, sha256: hash(value), updatedAt: '' };
    }
    outDir ??= await mkdtemp(join(tmpdir(), 'tpex-'));
    const manifest = await collectTpex({ outDir, previous, previousDir, now });
    let failed = manifest.failures.length > 0;
    for (const key of manifest.written) {
      const entry = manifest.keys[key];
      if (entry.sha256 === previous.keys[key]?.sha256) { console.log(`kv skip ${key} unchanged`); continue; }
      try {
        const value = await readFile(join(outDir, entry.file), 'utf8');
        const body = new FormData();
        body.set('value', value);
        body.set('metadata', JSON.stringify({ updatedAt: entry.updatedAt }));
        const response = await request(key, { method: 'PUT', body });
        const result = await response.json().catch(() => null) as { success?: boolean; errors?: { code: unknown; message: unknown }[] } | null;
        if (response.status === 200 && result?.success === true) {
          console.log(`kv put ${key} ${entry.bytes} bytes dataDate=${entry.dataDate} updatedAt=${entry.updatedAt}`);
        } else {
          failed = true;
          const errors = Array.isArray(result?.errors) ? result.errors.map(error => `${error.code}:${error.message}`).join(' ') : '';
          console.error(`kv put ${key} HTTP ${response.status}${errors ? ` ${errors.replaceAll(token, '[redacted]').replace(/\s+/g, ' ')}` : ''}`);
        }
      } catch { failed = true; console.error(`kv put ${key} failed`); }
    }
    return failed ? 1 : 0;
  } catch { console.error('tpex publish failed'); return 1; }
  finally { if (previousDir) await rm(previousDir, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--out' || !args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Usage: publish-tpex [--out <dir>]'); return 2;
    }
    outDir = args[i + 1];
  }
  return publishTpex({ outDir });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
