import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main, publishTpex } from '../scripts/publish-tpex.js';
import { buildStockSnapshot, decodeQuotesSnapshot } from '../src/core/snapshot.js';
import { encodeStoredSnapshot, keys, minimumRows } from '../src/worker/snapshot-keys.js';
import { stockUrls } from '../src/core/stock/source.js';
import { fixture } from './stock-fixtures.js';

const token = 'test-token-SECRET';
const env = { CLOUDFLARE_ACCOUNT_ID: 'test-account', KV_NAMESPACE_ID: 'test-namespace', CLOUDFLARE_KV_WRITE_TOKEN: token };
const base = 'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-namespace/values/';
const now = new Date('2026-10-29T08:00:00.000Z');
const tpexKeys = [keys.tpexQuotes, keys.tpexDividends];
const feedRows = (feed: string) => {
  const rows = fixture(feed) as Record<string, string>[];
  return feed === 'tpex-quotes' || feed === 'tpex-ratios' ? Array.from({ length: minimumRows.tpex }, (_, i) =>
    i < rows.length ? rows[i] : { ...rows[0], SecuritiesCompanyCode: `test-${i}` }) : rows;
};
const fixtureFetch = async (url: string) => feedRows(Object.entries(stockUrls).find(([, value]) => value === url)![0]);
let outDir: string;
let current: Map<string, string>;
let puts: Map<string, FormData>;
let readStatus: number | undefined;
let putResponse: () => Response;
let feedFailure: string | undefined;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'publish-tpex-'));
  current = new Map(); puts = new Map(); readStatus = undefined; feedFailure = undefined;
  putResponse = () => Response.json({ success: true });
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(base)) {
      expect(Object.values(stockUrls).filter(url => url.includes('tpex.org.tw'))).toContain(url);
      if (url === feedFailure) return Response.json([]);
      return Response.json(await fixtureFetch(url));
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const key = decodeURIComponent(url.slice(base.length));
    expect(url).toBe(`${base}${encodeURIComponent(key)}`);
    expect(tpexKeys).toContain(key);
    if (init?.method === 'PUT') {
      expect(init.body).toBeInstanceOf(FormData);
      puts.set(key, init.body as FormData);
      return putResponse();
    }
    return readStatus ? new Response(null, { status: readStatus }) : current.has(key)
      ? new Response(current.get(key)) : new Response(null, { status: 404 });
  }));
});
afterEach(async () => {
  try {
    const output = ['log', 'warn', 'error'].flatMap(method => vi.mocked(console[method as 'log']).mock.calls).flat().join('\n');
    expect(output.includes(token)).toBe(false);
    for (const value of current.values()) expect(output.includes(value)).toBe(false);
  } finally {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  }
});
const publish = () => publishTpex({ outDir, env, now });

it.each(Object.keys(env))('missing %s returns 2, prints only its name and never fetches', async name => {
  expect(await publishTpex({ outDir, env: { ...env, [name]: '' } })).toBe(2);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(name);
  expect(fetch).not.toHaveBeenCalled();
});

it('first publish puts both exact snapshot strings with encoded URLs and Worker metadata; second publish skips both', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  expect(await publish()).toBe(0);
  const snapshots = await buildStockSnapshot('tpex', fixtureFetch, () => now);
  expect([...puts.keys()]).toEqual(tpexKeys);
  for (const [key, snapshot] of [[keys.tpexQuotes, snapshots.quotes!], [keys.tpexDividends, snapshots.dividends!]] as const) {
    const body = puts.get(key)!;
    expect([...body.keys()]).toEqual(['value', 'metadata']);
    const encoded = encodeStoredSnapshot(key, snapshot);
    expect(body.get('value')).toBe(encoded);
    expect(body.get('metadata')).toBe(JSON.stringify({ updatedAt: now.toISOString() }));
    expect(await readFile(join(outDir, `${key.replaceAll(':', '_')}.json`), 'utf8')).toBe(encoded);
    expect(console.log).toHaveBeenCalledWith(`kv put ${key} ${new TextEncoder().encode(encoded).length} bytes dataDate=${key === keys.tpexQuotes ? '2026-10-22' : null} updatedAt=${now.toISOString()}`);
    current.set(key, encoded);
  }
  expect(timeout.mock.calls.filter(([ms]) => ms === 30_000)).toHaveLength(4);
  puts.clear(); vi.mocked(fetch).mockClear();
  expect(await publish()).toBe(0);
  expect(puts.size).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(5);
  for (const key of tpexKeys) expect(console.log).toHaveBeenCalledWith(`kv skip ${key} unchanged`);
});

it('rejects quotes older than KV but still publishes dividends and exits 1', async () => {
  const snapshot = (await buildStockSnapshot('tpex', fixtureFetch, () => now)).quotes!;
  snapshot.rows = snapshot.rows.map(row => ({ ...row, date: { year: 2026, month: 10, day: 23 } }));
  current.set(keys.tpexQuotes, encodeStoredSnapshot(keys.tpexQuotes, snapshot));
  expect(await publish()).toBe(1);
  expect([...puts.keys()]).toEqual([keys.tpexDividends]);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('stale date 2026-10-22 < 2026-10-23'));
});

it('KV read 500 stops before collection and all puts, without retry', async () => {
  readStatus = 500;
  expect(await publish()).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(puts.size).toBe(0);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(`kv read ${keys.tpexQuotes} HTTP 500`);
});

it('a failed second KV read also prevents every put', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === base + encodeURIComponent(keys.tpexDividends)
    ? new Response(null, { status: 500 }) : original(input, init));
  expect(await publish()).toBe(1);
  expect(puts.size).toBe(0);
  expect(console.error).toHaveBeenCalledWith(`kv read ${keys.tpexDividends} HTTP 500`);
});

it('PUT 403 logs only Cloudflare code:message, redacts the token, tries the other key and exits 1', async () => {
  putResponse = () => Response.json({ success: false, errors: [{ code: 10000, message: `Authentication error ${token}` }], private: 'never-log-body' }, { status: 403 });
  expect(await publish()).toBe(1);
  expect(puts.size).toBe(2);
  for (const key of tpexKeys) expect(console.error).toHaveBeenCalledWith(`kv put ${key} HTTP 403 10000:Authentication error [redacted]`);
  expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('never-log-body');
  expect(fetch).toHaveBeenCalledTimes(7);
});

it.each(['false-success', 'invalid-json'] as const)('PUT HTTP 200 with %s fails the run', async mode => {
  putResponse = () => mode === 'invalid-json' ? new Response('private-body') : Response.json({ success: false });
  expect(await publish()).toBe(1);
  expect(puts.size).toBe(2);
  for (const key of tpexKeys) expect(console.error).toHaveBeenCalledWith(`kv put ${key} HTTP 200`);
});

it('invalid previous snapshots are absent for collection and are replaced without logging their values', async () => {
  current.set(keys.tpexQuotes, 'invalid-quotes-private');
  current.set(keys.tpexDividends, 'invalid-dividends-private');
  expect(await publish()).toBe(0);
  expect(puts.size).toBe(2);
  for (const key of tpexKeys) expect(console.warn).toHaveBeenCalledWith(`kv read ${key} invalid snapshot; treating as absent`);
  expect(decodeQuotesSnapshot(String(puts.get(keys.tpexQuotes)!.get('value'))).rows).toHaveLength(minimumRows.tpex);
});

it('never publishes a failed snapshot, while publishing the other key', async () => {
  feedFailure = stockUrls['tpex-ratios'];
  expect(await publish()).toBe(1);
  expect([...puts.keys()]).toEqual([keys.tpexDividends]);
});

it('CLI rejects bad arguments without fetching', async () => {
  expect(await main(['--out'])).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('committed publisher bundle equals a fresh build and empty-env execution runs only publisher main', async () => {
  const output = join(outDir, 'publish-tpex.mjs');
  execFileSync(process.execPath, ['scripts/build-tpex.mjs', output]);
  expect((await readFile(output)).equals(await readFile('scripts/dist/publish-tpex.mjs'))).toBe(true);
  // Any accidental network access fails locally; empty env must stop before collect or fetch.
  const preload = join(outDir, 'no-network.mjs');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(preload, "globalThis.fetch = () => { throw new Error('network forbidden'); };\n");
  const run = spawnSync(process.execPath, ['--import', preload, 'scripts/dist/publish-tpex.mjs'], { env: {}, encoding: 'utf8' });
  expect(run.status).toBe(2);
  expect(run.stdout).toBe('');
  expect(run.stderr.trim().split('\n')).toEqual(Object.keys(env));
});

it('workflow keeps the token in step env, pins every action and limits permissions and runtime', async () => {
  const text = await readFile('.github/workflows/tpex-collect.yml', 'utf8');
  const tokenLines = text.split('\n').filter(line => line.includes('CLOUDFLARE_KV_WRITE_TOKEN'));
  expect(tokenLines).toEqual(['          CLOUDFLARE_KV_WRITE_TOKEN: ${{ secrets.CLOUDFLARE_KV_WRITE_TOKEN }}']);
  expect(text).toMatch(/      - run: node scripts\/dist\/publish-tpex\.mjs[^\n]*\n        env:\n          CLOUDFLARE_KV_WRITE_TOKEN:/);
  const actions = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(match => match[1]);
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/);
  expect(text).toMatch(/^permissions:\n  contents: read\n/m);
  expect(text).toMatch(/^    timeout-minutes: 5$/m);
  expect(text).toContain("cron: '17,47 6-10 * * 1-5'");
});
