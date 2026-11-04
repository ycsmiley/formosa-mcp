import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectTpex, main, type TpexManifest } from '../scripts/collect-tpex.js';
import { buildStockSnapshot, decodeQuotesSnapshot } from '../src/core/snapshot.js';
import { marketUrls, stockUrls } from '../src/core/stock/source.js';
import { encodeStoredSnapshot, keys, minimumRows } from '../src/worker/snapshot-keys.js';
import { marketFixtureFeed, fixture } from './stock-fixtures.js';

const now = new Date('2026-10-29T08:00:00.000Z');
const quoteFile = 'stock_quotes_tpex_v1.json', divFile = 'stock_dividends_tpex_v1.json';
// Expand the recorded quote and ratios samples to meet the production minimums.
const feedRows = (feed: string): Record<string, string>[] => {
  const rows = fixture(feed) as Record<string, string>[];
  return feed === 'tpex-quotes' || feed === 'tpex-ratios' ? Array.from({ length: minimumRows.tpex }, (_, i) =>
    i < rows.length ? rows[i] : { ...rows[0], SecuritiesCompanyCode: `test-${i}` }) : rows;
};
const fixtureFetch = async (url: string) => feedRows(Object.entries(stockUrls).find(([, value]) => value === url)![0]);
let outDir: string;
let overrides: Record<string, () => Response>;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'collect-tpex-'));
  overrides = {};
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (overrides[url]) return overrides[url]();
    if (Object.values(marketUrls).includes(url as any)) {
      const feed = await marketFixtureFeed(url);
      return Response.json(feed.body, { headers: { 'Last-Modified': feed.lastModified! } });
    }
    return Response.json(await fixtureFetch(url));
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(outDir, { recursive: true, force: true });
});
const collect = (previous?: TpexManifest, at = now) => collectTpex({ outDir, previous, now: at, retryDelayMs: 0 });
const readManifest = async (): Promise<TpexManifest> => JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));

it('writes exact Worker snapshot bytes and a complete manifest from recorded fixtures', async () => {
  const result = await collect();
  const expected = await buildStockSnapshot('tpex', fixtureFetch, () => now);
  expect(result).toEqual(await readManifest());
  expect(result).toMatchObject({ v: 1, market: 'tpex', generatedAt: now.toISOString(), written: [keys.tpexQuotes, keys.tpexDividends, keys.marketSummary], failures: [] });
  expect((await readdir(outDir)).sort()).toEqual(['manifest.json', quoteFile, divFile, 'stock_market_v1.json'].sort());
  for (const [key, file, snapshot, dataDate] of [
    [keys.tpexQuotes, quoteFile, expected.quotes!, '2026-10-22'],
    [keys.tpexDividends, divFile, expected.dividends!, null],
  ] as const) {
    const bytes = await readFile(join(outDir, file));
    const encoded = encodeStoredSnapshot(key, snapshot);
    expect(bytes).toEqual(Buffer.from(encoded, 'utf8'));
    expect(result.keys[key]).toEqual({ file, dataDate, rows: snapshot.rows.length, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), updatedAt: now.toISOString() });
  }
  const quotes = decodeQuotesSnapshot(await readFile(join(outDir, quoteFile), 'utf8'));
  expect(quotes.updatedAt).toBe('');
  expect(quotes.rows.find(row => row.code === '6488')).toMatchObject({ close: 826 });
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url).sort()).toEqual([...Object.entries(stockUrls).filter(([feed]) => feed.startsWith('tpex')).map(([, url]) => url), ...Object.values(marketUrls)].sort());
  for (const [, options] of vi.mocked(fetch).mock.calls) {
    expect(options).toMatchObject({ redirect: 'manual' });
    expect(Object.fromEntries(new Headers(options?.headers))).toEqual({
      accept: 'application/json', 'user-agent': 'formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)',
    });
  }
  expect(console.log).toHaveBeenCalledTimes(2);
});

it.each([
  ['302 redirect', () => new Response('redirect', { status: 302, headers: { Location: '/other' } }), 'HTTP 302'],
  ['200 HTML', () => new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }), 'Unexpected content-type: text/html'],
  ['empty array', () => Response.json([]), 'empty array'],
  ['missing field on a later row', () => {
    const rows = fixture('tpex-quotes') as Record<string, string>[];
    delete rows[rows.length - 1].Close;
    return Response.json(rows);
  }, 'missing required field Close'],
  ['non-string row field', () => Response.json([{ Date: '1151022', Close: 825 }]), '股票資料格式不正確'],
  ['invalid date', () => Response.json([{ Date: '1150230', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', Close: '825' }]), 'invalid Date'],
  ['too few parsed quotes', () => Response.json(feedRows('tpex-quotes').slice(0, minimumRows.tpex - 1)), 'too few parsed rows'],
])('keeps quotes untouched after %s while writing dividends', async (_label, response, message) => {
  await writeFile(join(outDir, quoteFile), 'last-known-good');
  overrides[stockUrls['tpex-quotes']] = response;
  const result = await collect();
  expect(result.written).toEqual([keys.tpexDividends, keys.marketSummary]);
  expect(result.failures).toEqual([{ key: keys.tpexQuotes, feed: 'tpex-quotes', reason: expect.stringContaining(message) }]);
  expect(await readFile(join(outDir, quoteFile), 'utf8')).toBe('last-known-good');
  expect(await readManifest()).toEqual(result);
  expect(result.keys[keys.tpexQuotes]).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`tpex collect fail ${keys.tpexQuotes} tpex-quotes: `));
});

it.each(['tpex-quotes', 'tpex-ratios'] as const)('rejects a stale %s date using the previous quotes entry', async feed => {
  const previous = await collect();
  previous.keys[keys.tpexQuotes].dataDate = '2026-10-23';
  // Keep the other dated feed current so the failing dependency is unambiguous.
  const other = feed === 'tpex-quotes' ? 'tpex-ratios' : 'tpex-quotes';
  overrides[stockUrls[other]] = () => Response.json(feedRows(other).map(row => ({ ...row, Date: '1151023' })));
  const bytes = await readFile(join(outDir, quoteFile));
  const result = await collect(previous);
  expect(result.written).toEqual([keys.tpexDividends, keys.marketSummary]);
  expect(result.failures).toEqual([{ key: keys.tpexQuotes, feed, reason: 'stale date 2026-10-22 < 2026-10-23' }]);
  expect(await readFile(join(outDir, quoteFile))).toEqual(bytes);
  expect(result.keys[keys.tpexQuotes]).toEqual(previous.keys[keys.tpexQuotes]);
});

it('carries the previous quotes entry across a ratios failure and checks it on the next run', async () => {
  const previous = await collect();
  const bytes = await readFile(join(outDir, quoteFile));
  overrides[stockUrls['tpex-ratios']] = () => Response.json([]);
  const partial = await collect(previous);
  expect(partial.written).toEqual([keys.tpexDividends, keys.marketSummary]);
  expect(partial.failures).toEqual([{ key: keys.tpexQuotes, feed: 'tpex-ratios', reason: 'too few ratios rows: 0 < 50' }]);
  expect(await readFile(join(outDir, quoteFile))).toEqual(bytes);
  expect(partial.keys[keys.tpexQuotes]).toEqual(previous.keys[keys.tpexQuotes]);
  delete overrides[stockUrls['tpex-ratios']];
  overrides[stockUrls['tpex-quotes']] = () => Response.json(feedRows('tpex-quotes').map(row => ({ ...row, Date: '1151021' })));
  expect((await collect(await readManifest())).failures[0].reason).toContain('stale date');
});

it('copies a carried file from the CLI previous manifest directory', async () => {
  const previousDir = await mkdtemp(join(outDir, 'previous-'));
  const previous = await collectTpex({ outDir: previousDir, now, retryDelayMs: 0 });
  const bytes = await readFile(join(previousDir, quoteFile));
  overrides[stockUrls['tpex-ratios']] = () => Response.json([]);
  expect(await main(['--out', outDir, '--previous', join(previousDir, 'manifest.json')])).toBe(1);
  const result = await readManifest();
  expect(result.written).toEqual([keys.tpexDividends, keys.marketSummary]);
  expect(result.keys[keys.tpexQuotes]).toEqual(previous.keys[keys.tpexQuotes]);
  expect(await readFile(join(outDir, quoteFile))).toEqual(bytes);
});

it.each(['missing', 'changed', 'unexpected-name'] as const)('drops a carried entry whose file is %s', async mode => {
  const previousDir = await mkdtemp(join(outDir, 'previous-'));
  const previous = await collectTpex({ outDir: previousDir, now, retryDelayMs: 0 });
  if (mode === 'missing') await rm(join(previousDir, quoteFile));
  else if (mode === 'changed') await writeFile(join(outDir, quoteFile), 'changed');
  else {
    await writeFile(join(previousDir, 'unexpected.json'), await readFile(join(previousDir, quoteFile)));
    previous.keys[keys.tpexQuotes].file = 'unexpected.json';
  }
  overrides[stockUrls['tpex-ratios']] = () => Response.json([]);
  const result = await collectTpex({ outDir, previous, previousDir, now, retryDelayMs: 0 });
  expect(result.keys[keys.tpexQuotes]).toBeUndefined();
  expect(await readManifest()).toEqual(result);
  expect(vi.mocked(console.warn).mock.calls.filter(([line]) => String(line).startsWith('tpex collect drop ')))
    .toEqual([[`tpex collect drop ${keys.tpexQuotes}: previous file missing or changed`]]);
  if (mode === 'missing') await expect(readFile(join(outDir, quoteFile))).rejects.toMatchObject({ code: 'ENOENT' });
  else if (mode === 'changed') expect(await readFile(join(outDir, quoteFile), 'utf8')).toBe('changed');
  else await expect(readFile(join(outDir, 'unexpected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([0, minimumRows.tpex - 1])('rejects %i ratios rows while writing dividends', async count => {
  overrides[stockUrls['tpex-ratios']] = () => Response.json(feedRows('tpex-ratios').slice(0, count));
  const result = await collect();
  expect(result.written).toEqual([keys.tpexDividends, keys.marketSummary]);
  expect(result.failures).toEqual([{ key: keys.tpexQuotes, feed: 'tpex-ratios', reason: `too few ratios rows: ${count} < 50` }]);
  await expect(readFile(join(outDir, quoteFile))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a dividends row without CompanyName while writing quotes', async () => {
  const rows = feedRows('tpex-div');
  delete rows[rows.length - 1].CompanyName;
  overrides[stockUrls['tpex-div']] = () => Response.json(rows);
  const result = await collect();
  expect(result.written).toEqual([keys.tpexQuotes, keys.marketSummary]);
  expect(result.failures).toEqual([{ key: keys.tpexDividends, feed: 'tpex-div', reason: 'missing required field CompanyName' }]);
  await expect(readFile(join(outDir, divFile))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves updatedAt for unchanged hashes and advances it for changed data', async () => {
  const previous = await collect(), later = new Date('2026-10-30T08:00:00.000Z');
  const unchanged = await collect(previous, later);
  expect(unchanged.written).toHaveLength(3);
  expect(unchanged.keys).toEqual(previous.keys);
  expect(unchanged.generatedAt).toBe(later.toISOString());
  overrides[stockUrls['tpex-quotes']] = () => Response.json(feedRows('tpex-quotes').map(row => ({ ...row, Close: '999' })));
  const changed = await collect(unchanged, later);
  expect(changed.keys[keys.tpexQuotes].updatedAt).toBe(later.toISOString());
  expect(changed.keys[keys.tpexQuotes].sha256).not.toBe(previous.keys[keys.tpexQuotes].sha256);
  expect(changed.keys[keys.tpexDividends]).toEqual(previous.keys[keys.tpexDividends]);
});

it.each(['empty', 'unparseable'] as const)('leaves dividends untouched for an %s schedule', async mode => {
  await writeFile(join(outDir, divFile), 'last-known-good');
  overrides[stockUrls['tpex-div']] = () => Response.json(mode === 'empty' ? [] : [{
    ExRrightsExDividendDate: 'invalid', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', ExRrightsExDividend: '除息',
  }]);
  const result = await collect();
  expect(result.written).toEqual([keys.tpexQuotes, keys.marketSummary]);
  expect(result.failures[0]).toMatchObject({ key: keys.tpexDividends, feed: 'tpex-div' });
  expect(await readFile(join(outDir, divFile), 'utf8')).toBe('last-known-good');
});

it('returns CLI status 0 for both snapshots and 1 for a partial failure', async () => {
  expect(await main(['--out', outDir])).toBe(0);
  overrides[stockUrls['tpex-ratios']] = () => Response.json([]);
  expect(await main(['--out', outDir, '--previous', join(outDir, 'manifest.json')])).toBe(1);
});

it.each([['--unknown'], ['--out'], ['--previous', '--out', 'foo'], ['extra', 'value']])('returns CLI status 2 for bad arguments %j', async (...args) => {
  expect(await main(args)).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
});

it.each(['missing', 'unreadable'] as const)('logs one line and ignores a %s previous manifest', async mode => {
  // A directory is unreadable as a manifest, even when the test runs as root.
  const path = mode === 'missing' ? join(outDir, 'missing.json') : outDir;
  expect(await main(['--out', outDir, '--previous', path])).toBe(0);
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('tpex collect previous manifest unavailable; treating as no previous');
});

it('writes one summary key with Last-Modified confirmation and keeps its bytes when only collection time changes', async () => {
  const first = await collect();
  const file = join(outDir, first.keys[keys.marketSummary].file);
  const bytes = await readFile(file, 'utf8');
  expect(JSON.parse(bytes)).toMatchObject({ twse: { margin: { dateConfirmed: true } }, tpex: { margin: { dateConfirmed: true } } });
  const next = await collect(first, new Date(now.getTime() + 3600000));
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect(next.keys[keys.marketSummary]).toEqual(first.keys[keys.marketSummary]);
});
it.each(['replace', 'drop'] as const)('%s an invalid previous market independently of the valid other market', async mode => {
  const previous = await collect();
  const entry = previous.keys[keys.marketSummary], file = join(outDir, entry.file);
  const summary = JSON.parse(await readFile(file, 'utf8'));
  const validTpex = summary.tpex;
  // Even a newer date cannot protect a block with missing required values.
  summary.twse = { dataDate: { year: 2026, month: 11, day: 4 } };
  const malformed = JSON.stringify(summary);
  await writeFile(file, malformed);
  entry.sha256 = createHash('sha256').update(malformed).digest('hex');
  if (mode === 'drop') overrides[marketUrls.fmtqik] = () => Response.json([]);
  await collect(previous);
  const next = JSON.parse(await readFile(file, 'utf8'));
  expect(next.tpex).toEqual(validTpex);
  if (mode === 'replace') expect(next.twse).toMatchObject({ dataDate: { day: 3 }, taiex: 43307.54 });
  else expect(next.twse).toBeUndefined();
});
it('summary failure only warns and leaves quotes/dividends results and CLI status unchanged', async () => {
  for (const url of Object.values(marketUrls)) overrides[url] = () => Response.json([]);
  expect(await main(['--out', outDir])).toBe(0);
  const result = await readManifest();
  expect(result.written).toEqual([keys.tpexQuotes, keys.tpexDividends]);
  expect(result.failures).toEqual([]);
  expect(result.keys[keys.marketSummary]).toBeUndefined();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('market summary collection failed'));
});
it('uses previous summary from the previous directory for a failed market and an unconfirmed margin', async () => {
  const previousDir = await mkdtemp(join(outDir, 'old-'));
  const previous = await collectTpex({ outDir: previousDir, now, retryDelayMs: 0 });
  const old = JSON.parse(await readFile(join(previousDir, 'stock_market_v1.json'), 'utf8'));
  overrides[marketUrls.fmtqik] = () => Response.json([]);
  const oneFailed = await collectTpex({ outDir, previous, previousDir, now, retryDelayMs: 0 });
  const summary = JSON.parse(await readFile(join(outDir, 'stock_market_v1.json'), 'utf8'));
  expect(oneFailed.failures).toEqual([]);
  expect(summary.twse).toEqual(old.twse);
  delete overrides[marketUrls.fmtqik];
  overrides[marketUrls.margn] = () => Response.json(fixture('market-margn'));
  await collectTpex({ outDir, previous, previousDir, now, retryDelayMs: 0 });
  const unconfirmed = JSON.parse(await readFile(join(outDir, 'stock_market_v1.json'), 'utf8'));
  expect(unconfirmed.twse.margin).toEqual(old.twse.margin);
  expect(unconfirmed.twse.marginReason).toContain('Last-Modified');
});
