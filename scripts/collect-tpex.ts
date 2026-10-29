import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStockSnapshot } from '../src/core/snapshot.js';
import { parseRocDate, stockRows } from '../src/core/stock/parse.js';
import { stockUrls } from '../src/core/stock/source.js';
import { encodeStoredSnapshot, keys, minimumRows } from '../src/worker/snapshot-keys.js';
import { fetchStockFeed } from '../src/worker/stock-source.js';

interface ManifestEntry {
  file: string; dataDate: string | null; rows: number; bytes: number; sha256: string; updatedAt: string;
}
export interface TpexManifest {
  v: 1; market: 'tpex'; generatedAt: string; written: string[];
  failures: { key: string; feed: string; reason: string }[];
  keys: Record<string, ManifestEntry>;
}
const feeds = ['tpex-quotes', 'tpex-ratios', 'tpex-div'] as const;
type Feed = typeof feeds[number];
const required: Record<Feed, string[]> = {
  'tpex-quotes': ['Date', 'SecuritiesCompanyCode', 'CompanyName', 'Close'],
  'tpex-ratios': ['Date', 'SecuritiesCompanyCode'],
  'tpex-div': ['ExRrightsExDividendDate', 'SecuritiesCompanyCode', 'CompanyName', 'ExRrightsExDividend'],
};
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();

async function atomicWrite(file: string, value: string | Uint8Array) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, value, 'utf8'); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}

export async function collectTpex({ outDir, previous, previousDir, now = new Date(), retryDelayMs = 1500 }: {
  outDir: string; previous?: TpexManifest; previousDir?: string; now?: Date; retryDelayMs?: number;
}): Promise<TpexManifest> {
  const generatedAt = now.toISOString();
  const manifest: TpexManifest = { v: 1, market: 'tpex', generatedAt, written: [], failures: [], keys: { ...previous?.keys } };
  const bodies = new Map<string, unknown>(), dates = new Map<Feed, string>();
  function fail(key: string, feed: string, error: unknown) {
    const failure = { key, feed, reason: reason(error) };
    manifest.failures.push(failure);
    console.warn(`tpex collect fail ${key} ${feed}: ${failure.reason}`);
  }
  const results = await Promise.allSettled(feeds.map(async feed => {
    const result = await fetchStockFeed(feed, stockUrls[feed], undefined, { retryDelayMs });
    if (result.status !== 200) throw new Error(`HTTP ${result.status}; expected 200`);
    const rows = stockRows(result.body);
    if (feed === 'tpex-ratios' && rows.length < minimumRows.tpex) {
      throw new Error(`too few ratios rows: ${rows.length} < ${minimumRows.tpex}`);
    }
    if (!rows.length) throw new Error('empty array');
    for (const row of rows) for (const field of required[feed]) {
      if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error(`missing required field ${field}`);
    }
    if (feed !== 'tpex-div') {
      let dataDate = '';
      for (const row of rows) {
        const date = parseRocDate(row.Date);
        if (!date) throw new Error(`invalid Date: ${row.Date}`);
        const iso = `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
        if (iso > dataDate) dataDate = iso;
      }
      const previousDate = previous?.keys[keys.tpexQuotes]?.dataDate;
      if (previousDate && dataDate < previousDate) throw new Error(`stale date ${dataDate} < ${previousDate}`);
      dates.set(feed, dataDate);
    }
    bodies.set(stockUrls[feed], result.body);
  }));
  results.forEach((result, i) => {
    if (result.status === 'rejected') fail(feeds[i] === 'tpex-div' ? keys.tpexDividends : keys.tpexQuotes, feeds[i], result.reason);
  });
  const snapshots = await buildStockSnapshot('tpex', async url => {
    if (!bodies.has(url)) throw new Error('invalid feed');
    return bodies.get(url);
  }, () => now);
  await mkdir(outDir, { recursive: true });
  for (const kind of ['quotes', 'dividends'] as const) {
    const key = kind === 'quotes' ? keys.tpexQuotes : keys.tpexDividends;
    if (manifest.failures.some(failure => failure.key === key)) continue;
    const snapshot = snapshots[kind], feed = kind === 'quotes' ? 'tpex-quotes' : 'tpex-div';
    try {
      if (!snapshot) throw new Error('no snapshot');
      const minimum = kind === 'quotes' ? minimumRows.tpex : 1;
      if (snapshot.rows.length < minimum) throw new Error(`too few parsed rows: ${snapshot.rows.length} < ${minimum}`);
      const encoded = encodeStoredSnapshot(key, snapshot), file = `${key.replaceAll(':', '_')}.json`;
      const sha256 = createHash('sha256').update(encoded, 'utf8').digest('hex');
      const old = previous?.keys[key];
      const entry: ManifestEntry = {
        file, dataDate: kind === 'quotes' ? dates.get('tpex-quotes')! : null,
        rows: snapshot.rows.length, bytes: new TextEncoder().encode(encoded).length, sha256,
        updatedAt: old?.sha256 === sha256 ? old.updatedAt : generatedAt,
      };
      await atomicWrite(join(outDir, file), encoded);
      manifest.keys[key] = entry;
      manifest.written.push(key);
      console.log(`tpex collect ok ${key} ${entry.bytes} bytes dataDate=${entry.dataDate}`);
    } catch (error) { fail(key, feed, error); }
  }
  for (const [key, entry] of Object.entries(manifest.keys)) {
    if (manifest.written.includes(key)) continue;
    try {
      if (entry.file !== `${key.replaceAll(':', '_')}.json`) throw new Error('unexpected file');
      const file = join(outDir, entry.file);
      let bytes: Buffer;
      try { bytes = await readFile(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !previousDir) throw error;
        await atomicWrite(file, await readFile(join(previousDir, entry.file)));
        bytes = await readFile(file);
      }
      if (createHash('sha256').update(bytes).digest('hex') === entry.sha256) continue;
    } catch { /* Unavailable carried files are omitted from the manifest. */ }
    delete manifest.keys[key];
    console.warn(`tpex collect drop ${key}: previous file missing or changed`);
  }
  await atomicWrite(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let outDir = 'out/tpex', previousPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--out', '--previous'].includes(flag) || !value || value.startsWith('--')) {
      console.error('Usage: collect-tpex [--out <dir>] [--previous <manifest.json>]');
      return 2;
    }
    if (flag === '--out') outDir = value;
    else previousPath = value;
  }
  let previous: TpexManifest | undefined;
  if (previousPath) {
    try {
      const parsed = JSON.parse(await readFile(previousPath, 'utf8'));
      if (parsed?.v !== 1 || parsed.market !== 'tpex' || !parsed.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) throw new Error('invalid manifest');
      previous = parsed;
    } catch { console.warn('tpex collect previous manifest unavailable; treating as no previous'); }
  }
  try {
    const manifest = await collectTpex({ outDir, previous, previousDir: previousPath ? dirname(previousPath) : undefined });
    return manifest.written.length === 2 ? 0 : 1;
  } catch (error) {
    console.error(`tpex collect fail: ${reason(error)}`);
    return 1;
  }
}

if (process.argv[1] && /^collect-tpex\.(ts|js)$/.test(basename(process.argv[1])) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
