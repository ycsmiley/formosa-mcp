import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { buildMarketSummary, formatMarketSummary } from '../src/core/stock/market.js';
import { createStockService } from '../src/core/stock/service.js';
import { fetchMarketFeed, marketUrls } from '../src/core/stock/source.js';
import { stockFooter } from '../src/core/stock/format.js';
import { marketFixtureFeed, marketInput } from './stock-fixtures.js';
const clock = () => new Date('2026-11-04T12:00:00+08:00');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('selects the max ROC date independently, sums recorded per-stock rows (blank = zero), in 張', () => {
  const input = marketInput();
  input.fmtqik = (input.fmtqik as object[]).reverse();
  const summary = buildMarketSummary(input);
  expect(summary).toEqual({
    twse: { dataDate: { year: 2026, month: 11, day: 3 }, taiex: 43307.54, change: -1612.60, value: 1002035660990,
      margin: { date: { year: 2026, month: 11, day: 3 }, dateConfirmed: true, financePrev: 2030228, finance: 2067024, shortPrev: 56203, short: 118721 } },
    tpex: { dataDate: { year: 2026, month: 11, day: 3 }, taiex: 345.52, change: -23.72, value: 197177872476,
      margin: { date: { year: 2026, month: 11, day: 3 }, dateConfirmed: true, financePrev: 28178, finance: 30032, shortPrev: 46, short: 149 } },
    fetchedAt: input.fetchedAt,
  });
});

it.each([
  [undefined, 'Tue, 03 Nov 2026 08:00:00 GMT', '缺少可解析'],
  ['invalid', 'Tue, 03 Nov 2026 08:00:00 GMT', '缺少可解析'],
  ['Tue, 03 Nov 2026 08:00:00 GMT', undefined, '缺少可解析'],
  ['Tue, 03 Nov 2026 08:00:00 GMT', 'invalid', '缺少可解析'],
  ['Tue, 03 Nov 2026 06:29:59 GMT', 'Tue, 03 Nov 2026 08:00:00 GMT', '早於'],
  ['Tue, 03 Nov 2026 08:00:00 GMT', 'Tue, 03 Nov 2026 06:29:59 GMT', '早於'],
  ['Tue, 03 Nov 2026 21:22:44 GMT', 'Tue, 03 Nov 2026 08:00:00 GMT', '舊超過 6 小時'],
  ['Tue, 03 Nov 2026 08:00:00 GMT', 'Tue, 03 Nov 2026 21:23:14 GMT', '新超過 6 小時'],
])('withholds unconfirmed TWSE margin for LM %s / %s', (fmtqikLastModified, margnLastModified, reason) => {
  const input = { ...marketInput(), fmtqikLastModified, margnLastModified };
  const summary = buildMarketSummary(input);
  expect(summary.twse?.margin).toBeUndefined();
  expect(summary.twse?.marginReason).toContain(reason);
  const text = formatMarketSummary(summary, clock);
  expect(text).toContain('融資券無法確認資料日期');
  expect(text).toContain('融資券暫不提供');
  expect(text).not.toContain('2,067,024');
  expect(summary.tpex?.margin?.dateConfirmed).toBe(true);
});
it('accepts close and six-hour boundary inclusively', () => {
  expect(buildMarketSummary({ ...marketInput(), fmtqikLastModified: 'Tue, 03 Nov 2026 06:30:00 GMT', margnLastModified: 'Tue, 03 Nov 2026 12:30:00 GMT' }).twse?.margin?.dateConfirmed).toBe(true);
});
it('rejects newly advanced FMTQIK paired with the prior pre-close margin header', () => {
  const input = marketInput();
  input.fmtqik = (input.fmtqik as Record<string, string>[]).map(r => ({ ...r, Date: '1151104' }));
  const summary = buildMarketSummary({ ...input, fmtqikLastModified: 'Wed, 04 Nov 2026 08:00:00 GMT', margnLastModified: 'Tue, 03 Nov 2026 08:00:00 GMT' });
  expect(summary.twse?.dataDate.day).toBe(4);
  expect(summary.twse?.marginReason).toContain('早於');
});

it.each(['twse', 'tpex'] as const)('keeps the previous confirmed %s margin with its own date across repeated uncertainty', market => {
  const previous = buildMarketSummary(marketInput());
  const input = marketInput();
  if (market === 'twse') {
    input.fmtqik = (input.fmtqik as Record<string, string>[]).map(r => ({ ...r, Date: '1151104' }));
    input.margnLastModified = '';
  } else input.tpexIndex = (input.tpexIndex as Record<string, string>[]).map(r => ({ ...r, Date: '1151104' }));
  const result = buildMarketSummary(input, buildMarketSummary(input, previous));
  expect(result[market]?.dataDate.day).toBe(4);
  expect(result[market]?.margin).toEqual(previous[market]?.margin);
  const text = formatMarketSummary(result, clock);
  expect(text).toContain('上次確認的融資券資料日期：115年11月03日');
  expect(text).toContain('無法確認資料日期');
});

it.each(['mixed', 'other-day'] as const)('withholds TPEx margin for %s dates', kind => {
  const input = marketInput();
  input.tpexMargin = (input.tpexMargin as Record<string, string>[]).map((r, i) => ({ ...r, Date: kind === 'other-day' || i === 0 ? '1151102' : r.Date }));
  const result = buildMarketSummary(input);
  expect(result.tpex?.margin).toBeUndefined();
  expect(result.tpex?.marginReason).toContain('未全部等於');
});

it.each([
  ['fmtqik', []], ['fmtqik', {}], ['fmtqik', [{ Date: '1150230' }]],
  ['margn', []], ['margn', [{ '融資今日餘額': 'oops' }]], ['tpexIndex', []], ['tpexMargin', []],
] as const)('retains a failed market (%s) and serves the independently fresh other market', (key, body) => {
  const previous = buildMarketSummary(marketInput());
  const result = buildMarketSummary({ ...marketInput(), [key]: body }, previous);
  const market = key.startsWith('tpex') ? 'tpex' : 'twse';
  expect(result[market]).toBe(previous[market]);
  expect(result[market === 'tpex' ? 'twse' : 'tpex']).toBeDefined();
  expect(buildMarketSummary({ ...marketInput(), [key]: body })[market]).toBeUndefined();
});
it.each(['margn', 'tpexMargin'] as const)('rejects too few, missing or malformed numeric rows in %s', key => {
  for (const mode of ['too-few', 'missing', 'bad-number']) {
    const input = marketInput(), data = input[key] as Record<string, string>[];
    const field = key === 'margn' ? '融資今日餘額' : 'MarginPurchaseBalance';
    if (mode === 'too-few') data.pop();
    else if (mode === 'missing') delete data.at(-1)![field];
    else data.at(-1)![field] = 'garbled';
    expect(buildMarketSummary(input)[key === 'margn' ? 'twse' : 'tpex']).toBeUndefined();
  }
});
it('throws when both markets are malformed without previous data', () => {
  expect(() => buildMarketSummary({ ...marketInput(), fmtqik: [], tpexIndex: [] })).toThrow();
});

it('formats separate dates, signed point/percentage change, 億元 and 張, sources and disclaimer', () => {
  const summary = buildMarketSummary(marketInput());
  summary.tpex!.dataDate.day = 4;
  summary.tpex!.change = 1;
  const text = formatMarketSummary(summary, clock);
  expect(text).toContain('上市\n資料日期：115年11月03日（盤後資料，非即時）');
  expect(text).toContain('上櫃\n資料日期：115年11月04日（盤後資料，非即時）');
  expect(text).toContain('收盤 43,307.54｜漲跌 -1,612.60 點（-3.59%）');
  expect(text).toContain('漲跌 +1.00 點');
  expect(text).toContain('成交金額 10,020.36 億元');
  expect(text).toContain('融資餘額 2,067,024 張（較前日 +36,796 張）');
  summary.twse!.margin!.short = 0;
  expect(formatMarketSummary(summary, clock)).toContain('融券餘額 0 張（較前日 -56,203 張）');
  for (const url of Object.values(marketUrls)) expect(text).toContain(url);
  expect(text).toContain('FMTQIK'); expect(text).toContain('MI_MARGN');
  expect(text.endsWith(`${stockFooter}\n股票資料為盤後資料，僅供參考，不構成投資建議。`)).toBe(true);
  expect(text).not.toMatch(/undefined|null|NaN|\[object|\{|仟|千元/);
});
it.each([
  ['2026-11-04T08:59:00+08:00', false], ['2026-11-04T09:00:00+08:00', true],
  ['2026-11-04T13:30:00+08:00', true], ['2026-11-04T13:31:00+08:00', false],
  ['2026-11-07T12:00:00+08:00', false], ['2026-11-08T12:00:00+08:00', false],
])('trading-hours sentence at %s = %s', (now, included) => {
  const text = formatMarketSummary(buildMarketSummary(marketInput()), () => new Date(now));
  expect(text.split('這是前一個交易日收盤資料，不是即時行情').length - 1).toBe(included ? 1 : 0);
});
it.each([
  ['2026-11-04T18:00:00+08:00', false], ['2026-11-05T09:00:00+08:00', false],
  ['2026-11-05T18:00:00+08:00', true], ['2026-11-09T12:00:00+08:00', true],
])('warns after more than one expected weekday behind at %s = %s', (now, included) => {
  expect(formatMarketSummary(buildMarketSummary(marketInput()), () => new Date(now)).includes('注意：上市資料停在')).toBe(included);
});
it('does not count weekend days as staleness and keeps dated data across holidays', () => {
  const summary = buildMarketSummary(marketInput());
  summary.twse!.dataDate.day = 6; // Friday
  expect(formatMarketSummary(summary, () => new Date('2026-11-09T12:00:00+08:00'))).not.toContain('注意：上市');
  expect(formatMarketSummary(summary, () => new Date('2026-11-12T12:00:00+08:00'))).toContain('115年11月06日');
});

it('local service fetches four feeds once per hour including headers and retains confirmed margin', async () => {
  let now = clock();
  const feed = vi.fn(marketFixtureFeed);
  const service = createStockService({ clock: () => now, fetchMarketFeed: feed });
  expect((await service.marketSummary()).isError).toBe(false);
  await service.marketSummary(); expect(feed).toHaveBeenCalledTimes(4);
  now = new Date(now.getTime() + 3600000);
  feed.mockImplementation(async url => ({ ...await marketFixtureFeed(url), lastModified: undefined }));
  const result = await service.marketSummary();
  expect(feed).toHaveBeenCalledTimes(8);
  expect(result.text).toContain('上次確認的融資券資料日期：115年11月03日');
});
it('local network failure names the official sources and all URLs, retries without caching failure', async () => {
  const feed = vi.fn().mockRejectedValue(new Error('network offline'));
  const service = createStockService({ fetchMarketFeed: feed });
  const result = await service.marketSummary();
  expect(result.isError).toBe(true); expect(result.text).toContain('證交所／櫃買中心');
  for (const url of Object.values(marketUrls)) expect(result.text).toContain(url);
  feed.mockImplementation(marketFixtureFeed);
  expect((await service.marketSummary()).isError).toBe(false);
});
it('local header helper reads Last-Modified and gives source URLs on failure', async () => {
  const feed = await marketFixtureFeed(marketUrls.fmtqik);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(feed.body, { headers: { 'Last-Modified': feed.lastModified! } })));
  expect(await fetchMarketFeed(marketUrls.fmtqik)).toEqual(feed);
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await expect(fetchMarketFeed(marketUrls.tpexIndex)).rejects.toThrow(marketUrls.tpexIndex);
});
it('never includes the forbidden host anywhere in src/ or scripts/*.ts', () => {
  function check(dir: string, recurse: boolean) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory() && recurse) check(file, true);
      else if (entry.isFile() && (recurse || entry.name.endsWith('.ts'))) expect(readFileSync(file, 'utf8'), file).not.toContain('mis.twse');
    }
  }
  check('src', true); check('scripts', false);
});
