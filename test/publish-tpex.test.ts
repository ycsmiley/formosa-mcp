import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main, publishTpex } from '../scripts/publish-tpex.js';
import { buildStockSnapshot, decodeQuotesSnapshot } from '../src/core/snapshot.js';
import { collectKeys, encodeStoredSnapshot, keys, minimumRows } from '../src/worker/snapshot-keys.js';
import { buildCollector } from '../scripts/build-collectors.mjs';
import { marketUrls, stockUrls } from '../src/core/stock/source.js';
import { marketFixtureFeed, fixture } from './stock-fixtures.js';

const token = 'test-token-SECRET';
const env = { CLOUDFLARE_ACCOUNT_ID: 'test-account', KV_NAMESPACE_ID: 'test-namespace', CLOUDFLARE_KV_WRITE_TOKEN: token };
const base = 'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-namespace/values/';
const now = new Date('2026-10-29T08:00:00.000Z');
const tpexKeys = [keys.tpexQuotes, keys.tpexDividends, keys.marketSummary];
const feedRows = (feed: string) => {
  const rows = fixture(feed) as Record<string, string>[];
  return feed === 'tpex-quotes' || feed === 'tpex-ratios' ? Array.from({ length: minimumRows.tpex }, (_, i) =>
    i < rows.length ? rows[i] : { ...rows[0], SecuritiesCompanyCode: `test-${i}` }) : rows;
};
const fixtureFetch = async (url: string) => feedRows(Object.entries(stockUrls).find(([, value]) => value === url)![0]);
let outDir: string;
let current: Map<string, string>;
let puts: Map<string, FormData>;
let heartbeats: string[];
let heartbeatResponse: () => Response;
let readStatus: number | undefined;
let putResponse: () => Response;
let feedFailure: string | undefined;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'publish-tpex-'));
  current = new Map(); puts = new Map(); heartbeats = []; readStatus = undefined; feedFailure = undefined;
  putResponse = () => Response.json({ success: true });
  heartbeatResponse = () => Response.json({ success: true });
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(base)) {
      expect([...Object.values(stockUrls), ...Object.values(marketUrls)]).toContain(url);
      if (url === feedFailure) return Response.json([]);
      if (Object.values(marketUrls).includes(url as any)) {
        const feed = await marketFixtureFeed(url);
        return Response.json(feed.body, { headers: { 'Last-Modified': feed.lastModified! } });
      }
      return Response.json(await fixtureFetch(url));
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const key = decodeURIComponent(url.slice(base.length));
    expect(url).toBe(`${base}${encodeURIComponent(key)}`);
    if (key === collectKeys.tpex) {
      expect(init?.method).toBe('PUT');
      expect(typeof init.body).toBe('string');
      heartbeats.push(init.body as string);
      return heartbeatResponse();
    }
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
  const heartbeat = JSON.stringify({ v: 1, lastSuccessAt: now.toISOString(), dataDate: '2026-10-22' });
  expect(heartbeats).toEqual([heartbeat]);
  const putKeys = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url]) => decodeURIComponent(String(url).slice(base.length)));
  expect(putKeys()).toEqual([...tpexKeys, collectKeys.tpex]);
  expect(console.log).toHaveBeenCalledWith(`kv heartbeat lastSuccessAt=${now.toISOString()} dataDate=2026-10-22`);
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
  current.set(keys.marketSummary, String(puts.get(keys.marketSummary)!.get('value')));
  expect(timeout.mock.calls.filter(([ms]) => ms === 30_000)).toHaveLength(7);
  puts.clear(); heartbeats = []; vi.mocked(fetch).mockClear();
  expect(await publish()).toBe(0);
  expect(puts.size).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(11);
  expect(heartbeats).toEqual([heartbeat]);
  expect(putKeys()).toEqual([collectKeys.tpex]);
  for (const key of tpexKeys) expect(console.log).toHaveBeenCalledWith(`kv skip ${key} unchanged`);
});

it('rejects quotes older than KV but still publishes dividends and exits 1', async () => {
  const snapshot = (await buildStockSnapshot('tpex', fixtureFetch, () => now)).quotes!;
  snapshot.rows = snapshot.rows.map(row => ({ ...row, date: { year: 2026, month: 10, day: 23 } }));
  current.set(keys.tpexQuotes, encodeStoredSnapshot(keys.tpexQuotes, snapshot));
  expect(await publish()).toBe(1);
  expect([...puts.keys()]).toEqual([keys.tpexDividends, keys.marketSummary]);
  expect(heartbeats).toEqual([]);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('stale date 2026-10-22 < 2026-10-23'));
});

it('KV read 500 stops before collection and all puts, without retry', async () => {
  readStatus = 500;
  expect(await publish()).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(puts.size).toBe(0);
  expect(heartbeats).toEqual([]);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(`kv read ${keys.tpexQuotes} HTTP 500`);
});

it('a failed second KV read also prevents every put', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === base + encodeURIComponent(keys.tpexDividends)
    ? new Response(null, { status: 500 }) : original(input, init));
  expect(await publish()).toBe(1);
  expect(puts.size).toBe(0);
  expect(heartbeats).toEqual([]);
  expect(console.error).toHaveBeenCalledWith(`kv read ${keys.tpexDividends} HTTP 500`);
});

it('PUT 403 logs only Cloudflare code:message, redacts the token, tries the other key and exits 1', async () => {
  putResponse = () => Response.json({ success: false, errors: [{ code: 10000, message: `Authentication error ${token}` }], private: 'never-log-body' }, { status: 403 });
  expect(await publish()).toBe(1);
  expect(puts.size).toBe(3);
  expect(heartbeats).toEqual([]);
  for (const key of tpexKeys.filter(key => key !== keys.marketSummary)) expect(console.error).toHaveBeenCalledWith(`kv put ${key} HTTP 403 10000:Authentication error [redacted]`);
  expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('never-log-body');
  expect(fetch).toHaveBeenCalledTimes(13);
});

it.each(['false-success', 'invalid-json'] as const)('PUT HTTP 200 with %s fails the run', async mode => {
  putResponse = () => mode === 'invalid-json' ? new Response('private-body') : Response.json({ success: false });
  expect(await publish()).toBe(1);
  expect(puts.size).toBe(3);
  expect(heartbeats).toEqual([]);
  for (const key of tpexKeys.filter(key => key !== keys.marketSummary)) expect(console.error).toHaveBeenCalledWith(`kv put ${key} HTTP 200`);
});

it('invalid previous snapshots are absent for collection and are replaced without logging their values', async () => {
  current.set(keys.tpexQuotes, 'invalid-quotes-private');
  current.set(keys.tpexDividends, 'invalid-dividends-private');
  expect(await publish()).toBe(0);
  expect(puts.size).toBe(3);
  for (const key of tpexKeys.filter(key => key !== keys.marketSummary)) expect(console.warn).toHaveBeenCalledWith(`kv read ${key} invalid snapshot; treating as absent`);
  expect(decodeQuotesSnapshot(String(puts.get(keys.tpexQuotes)!.get('value'))).rows).toHaveLength(minimumRows.tpex);
});

it.each(['tpex-ratios', 'tpex-div'] as const)('never publishes failed %s or a heartbeat, while publishing the other key', async feed => {
  feedFailure = stockUrls[feed];
  expect(await publish()).toBe(1);
  expect([...puts.keys()]).toEqual([feed === 'tpex-div' ? keys.tpexQuotes : keys.tpexDividends, keys.marketSummary]);
  expect(heartbeats).toEqual([]);
});

it.each(['http', 'false-success', 'invalid-json', 'throw'] as const)('failed heartbeat (%s) exits 1 after publishing data, without logging response bodies', async mode => {
  heartbeatResponse = () => {
    if (mode === 'throw') throw new Error(`private ${token}`);
    if (mode === 'invalid-json') return new Response(`private ${token}`);
    return Response.json({ success: false, errors: [{ message: `private ${token}` }] }, { status: mode === 'http' ? 403 : 200 });
  };
  expect(await publish()).toBe(1);
  expect([...puts.keys()]).toEqual(tpexKeys);
  expect(heartbeats).toHaveLength(1);
  expect(console.error).toHaveBeenCalledWith(`kv put ${collectKeys.tpex} ${mode === 'throw' ? 'failed' : `HTTP ${mode === 'http' ? 403 : 200}`}`);
  expect(vi.mocked(console.log).mock.calls.flat().some(line => String(line).startsWith('kv heartbeat'))).toBe(false);
});

it('CLI rejects bad arguments without fetching', async () => {
  expect(await main(['--out'])).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('committed publisher bundle equals a fresh build and empty-env execution runs only publisher main', async () => {
  const output = join(outDir, 'publish-tpex.mjs');
  await buildCollector('tpex', output);
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
  expect(text).toContain('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22');
  expect(text).not.toContain('cache:');
  expect(text).toContain('      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
  for (const line of text.split('\n').filter(line => line.includes('ACCOUNT_ID'))) {
    expect(line).not.toMatch(/[0-9a-f]{32}/i);
  }
  expect(text).toContain('      KV_NAMESPACE_ID: e92149e1efec4434835310d434b69f7d');
  const guard = '      - run: test -n "$CLOUDFLARE_ACCOUNT_ID" || { echo "::error::CLOUDFLARE_ACCOUNT_ID repo variable is empty"; exit 1; }';
  expect(text).toContain(guard);
  expect(text.indexOf(guard)).toBeLessThan(text.indexOf('      - run: node scripts/dist/publish-tpex.mjs'));
  expect(text).toMatch(/^permissions:\n  contents: read\n/m);
  expect(text).toMatch(/^    timeout-minutes: 5$/m);
  expect(text).toContain("cron: '17,47 6-10 * * 1-5'");
});

it.each(['read', 'read-body', 'read-throw', 'put', 'put-throw', 'feeds'] as const)('market summary %s failure is warning-only and does not suppress quote heartbeat', async mode => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (mode === 'feeds' && Object.values(marketUrls).includes(url as any)) return Response.json([]);
    if (url === base + encodeURIComponent(keys.marketSummary)) {
      if (init?.method !== 'PUT') {
        if (mode === 'read') return new Response(null, { status: 500 });
        if (mode === 'read-throw') throw new Error(`private ${token}`);
        if (mode === 'read-body') return { status: 200, text: async () => { throw new Error(`private ${token}`); } } as unknown as Response;
      }
      if (mode === 'put-throw' && init?.method === 'PUT') throw new Error(`private ${token}`);
      if (mode === 'put' && init?.method === 'PUT') return Response.json({ success: false }, { status: 403 });
    }
    return original(input, init);
  });
  expect(await publish()).toBe(0);
  expect(puts.has(keys.tpexQuotes)).toBe(true);
  expect(puts.has(keys.tpexDividends)).toBe(true);
  expect(heartbeats).toHaveLength(1);
  expect(console.warn).toHaveBeenCalled();
});
it('reuses confirmed KV margin when newly fetched TWSE headers cannot confirm the date', async () => {
  await publish();
  const previous = String(puts.get(keys.marketSummary)!.get('value'));
  current.set(keys.marketSummary, previous);
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === marketUrls.margn
    ? Response.json((await marketFixtureFeed(marketUrls.margn)).body) : original(input, init));
  expect(await publish()).toBe(0);
  const next = JSON.parse(String(puts.get(keys.marketSummary)!.get('value')));
  expect(next.twse.margin).toEqual(JSON.parse(previous).twse.margin);
  expect(next.twse.marginReason).toContain('Last-Modified');
});
