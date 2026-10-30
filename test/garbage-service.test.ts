import { describe, expect, it } from 'vitest';
import { createGarbageService } from '../src/core/garbage/service.js';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/core/garbage/normalize.js';
import { decodeShard, encodeShard, type Index, type Shard } from '../src/core/garbage/snapshot.js';
const index: Index = { v: 2, generatedAt: '2026-10-30T00:00:00Z', cities: { ntpc: { gen: 'abc', fetchedAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', stops: 1, districts: { 板橋區: { stops: 1, sha256: 'a'.repeat(64) } } } } };
const shard: Shard = { v: 2, stops: [{ district: '板橋區', village: '文化里', route: 'A1', name: '文化路１號', garbage: [{ days: 1 << 5, start: '16:30', end: '' }], recycling: [], food: [] }] };
const service = createGarbageService({ index: async () => index, shard: async (_c, _g, d, k, filter) => decodeShard(encodeShard(shard), d, k, filter) }, () => new Date('2026-10-30T00:00:00Z'));
describe('garbage schedule service', () => {
  it('resolves district from keyword, normalizes digits, filters and warns about stale data', async () => {
    const result = await service.schedule({ city: '新北', keyword: '板橋 文化路1號', weekday: '週五', time: '16:00' });
    expect(result.text).toContain('文化路１號');
    expect(result.text).toContain('資料可能已過時');
    expect(result.text).not.toMatch(/[{}]/);
  });
  it('explains no results and unsupported cities', async () => {
    expect((await service.schedule({ city: '新北市', district: '板橋', keyword: '文化路', time: '17:00' })).text).toContain('新北市板橋區「文化路」：有收運點，但不符合指定的星期或時間。');
    expect((await service.schedule({ city: '新北市', district: '板橋', keyword: '不存在' })).text).toContain('找不到');
    expect((await service.schedule({ city: '桃園' })).text).toContain('尚未支援');
  });
  it('reports missing snapshots', async () => {
    const empty = createGarbageService({ index: async () => null, shard: async () => null });
    expect(await empty.schedule({ city: '新北' })).toEqual({ text: '資料更新中，請稍後再試', isError: true });
  });
});

it('renders and filters a Taipei recycling-only stop', async () => {
  const stop = normalize('taipei', readFileSync('test/fixtures/garbage/real/taipei.csv', 'utf8'), new Date()).find(s => s.name.includes('登山路25之1號'))!;
  const entry = { ...index.cities.ntpc!, districts: { 北投區: { stops: 1, sha256: 'a'.repeat(64) } } };
  const svc = createGarbageService({ index: async () => ({ ...index, cities: { taipei: entry } }), shard: async () => ({ v: 2, stops: [stop] }) });
  const query = { city: '台北', district: '北投', keyword: '登山路25之1號' };
  const result = await svc.schedule({ ...query, weekday: '週二', time: '17:00' });
  expect(result.text).toContain('資源回收：週二、五 17:03–17:05');
  expect(result.text).toContain('備註：僅資源回收車收運');
  expect(result.text).not.toContain('一般垃圾：');
  expect((await svc.schedule({ ...query, weekday: '週一' })).text).toContain('不符合指定的星期或時間');
  expect((await svc.schedule({ ...query, time: '18:00' })).text).toContain('不符合指定的星期或時間');
});

it('explains Taipei weekday rules and Kaohsiung capture day', async () => {
  const entry = index.cities.ntpc!;
  for (const [city, code, quirk] of [['台北', 'taipei', '部分回收日依站點名稱標示'], ['高雄', 'kaohsiung', '高雄市資料只含 10/25（星期日）當日班表']] as const) {
    const svc = createGarbageService({ index: async () => ({ ...index, cities: { [code]: { ...entry, capturedWeekday: 0 } } }), shard: async () => shard }, () => new Date('2026-10-30T00:00:00Z'));
    const text = (await svc.schedule({ city, district: '板橋', keyword: '文化' })).text;
    expect(text).toContain(quirk);
    expect(text).toContain(code === 'taipei' ? '廚餘依環保局規則隨垃圾車收運' : '（非今日資料）');
  }
});

it('distinguishes thrown store errors and missing shards', async () => {
  const broken = createGarbageService({ index: async () => { throw Error('private detail'); }, shard: async () => null });
  expect(await broken.schedule({ city: '新北' })).toEqual({ text: '暫時無法取得垃圾車資料，請稍後再試。', isError: true });
  const missing = createGarbageService({ index: async () => index, shard: async () => null }, () => new Date('2026-10-30T00:00:00Z'));
  expect(await missing.schedule({ city: '新北', district: '板橋', keyword: '文化' })).toEqual({ text: '資料更新中，請稍後再試', isError: true });
});

it('explains when a requested weekday differs from the Kaohsiung capture', async () => {
  let calls = 0;
  const svc = createGarbageService({ index: async () => ({ ...index, cities: { kaohsiung: { ...index.cities.ntpc!, capturedWeekday: 0 } } }), shard: async () => { calls++; return shard; } }, () => new Date('2026-10-30T00:00:00Z'));
  expect(await svc.schedule({ city: '高雄', district: '板橋', keyword: '文化', weekday: '週一' })).toEqual({ text: '高雄市資料只含 10/25（星期日）當日班表，無法查詢 11/2（星期一）。', isError: false });
  expect(calls).toBe(0);
});

it('asks for a keyword without loading a shard', async () => {
  let calls = 0;
  const svc = createGarbageService({ index: async () => index, shard: async () => { calls++; return shard; } });
  for (const query of [{ city: '新北', district: '板橋' }, { city: '新北', keyword: '板橋區' }]) {
    expect(await svc.schedule(query)).toEqual({ text: '請提供里名、路名或地點關鍵字，例如「板橋 文化路」。', isError: false });
  }
  expect(calls).toBe(0);
});

it('compares Kaohsiung calendar dates and formats identical slot endpoints', async () => {
  const entry = { ...index.cities.ntpc!, fetchedAt: '2026-10-23T00:00:00Z', capturedWeekday: 5 };
  const point = { ...shard, stops: [{ ...shard.stops[0], garbage: [{ days: 1 << 5, start: '18:01', end: '18:01' }] }] };
  const svc = createGarbageService({ index: async () => ({ ...index, cities: { kaohsiung: entry } }), shard: async () => point }, () => new Date('2026-10-30T00:00:00Z'));
  const query = { city: '高雄', district: '板橋', keyword: '文化', weekday: '今天' };
  expect((await svc.schedule(query)).text).toContain('無法查詢 10/30（星期五）');
  entry.fetchedAt = '2026-10-30T00:00:00Z';
  const result = await svc.schedule(query);
  expect(result.text).toContain('週五 18:01');
  expect(result.text).not.toContain('18:01–18:01');
});

it('infers only district prefixes or separate full district tokens', async () => {
  const entry = { ...index.cities.ntpc!, districts: { 東區: { stops: 1, sha256: 'a'.repeat(64) }, 西屯區: { stops: 1, sha256: 'b'.repeat(64) }, 板橋區: { stops: 1, sha256: 'c'.repeat(64) } } };
  const calls: string[] = [];
  const svc = createGarbageService({ index: async () => ({ ...index, cities: { tainan: entry } }), shard: async (_c, _g, d, k) => { calls.push(`${d}:${k}`); return { v: 2, stops: [] }; } });
  expect((await svc.schedule({ city: '台南', keyword: '和平東路' })).text).toContain('請指定行政區');
  for (const keyword of ['板橋文化路', '西屯 河南路', '東區和平路', '和平 東區 路']) await svc.schedule({ city: '台南', keyword });
  expect(calls).toEqual(['板橋區:板橋文化路', '板橋區:文化路', '西屯區:西屯 河南路', '西屯區:河南路', '東區:和平路', '東區:和平  路']);
});

it('validates keywords before loading a shard', async () => {
  let calls = 0;
  const svc = createGarbageService({ index: async () => index, shard: async () => { calls++; return shard; } });
  for (const keyword of ['路', '1', '123', '，。', '板橋區路', '板橋區123', '文化"路', '文化\\路', '""']) {
    expect((await svc.schedule({ city: '新北', keyword: keyword.startsWith('板橋') ? keyword : `板橋區${keyword}` })).text).toContain('關鍵字太短或無效');
  }
  expect((await svc.schedule({ city: '新北', district: '板橋', keyword: '\u200b\u200c\u200d\u2060\ufeff' })).text).toContain('請提供');
  expect(calls).toBe(0);
});

it('returns Taipei closure days without reading a shard', async () => {
  let calls = 0;
  const svc = createGarbageService({ index: async () => ({ ...index, cities: { taipei: index.cities.ntpc! } }), shard: async () => { calls++; return shard; } }, () => new Date('2026-10-31T00:00:00Z'));
  for (const weekday of ['週三', '週日', '明天']) expect((await svc.schedule({ city: '台北', district: '板橋', keyword: '文化', weekday })).text).toBe('臺北市週三、週日停收垃圾、資源回收及廚餘（環保局週收五日規則）。\n資料來源：臺北市政府環境保護局「臺北市垃圾車點位路線資訊」，政府資料開放授權條款第1版（OGDL-1）\n實際收運以各地環保局公告為準（國定假日可能調整）');
  expect(calls).toBe(0);
});

it('reports stale missing shards and too many matches', async () => {
  const missing = createGarbageService({ index: async () => index, shard: async () => null }, () => new Date('2026-11-10T00:00:00Z'));
  expect((await missing.schedule({ city: '新北', district: '板橋', keyword: '文化' })).text).toBe('垃圾車資料已過時，請稍後再試。');
  const many = createGarbageService({ index: async () => index, shard: async () => ({ v: 2, stops: Array.from({ length: 200 }, (_, i) => ({ ...shard.stops[0], name: `文化路${i}號` })), truncated: true }) });
  const result = await many.schedule({ city: '新北', district: '板橋', keyword: '文化' });
  expect(result.text).toContain('超過 200 個收運點，以下列出前 15 個');
  expect(result.text.match(/文化路\d+號（文化里，路線 A1）/g)).toHaveLength(15);
  expect(result.text).toContain('符合的收運點太多，請加上里名、路段或時間縮小範圍。');
  expect(result.text).toContain('資料來源：');
  expect(result.text).not.toContain('共 1 個收運點');
});


it('filters slots before applying the shard limit and retains keyword match information', async () => {
  const stops = Array.from({ length: 250 }, (_, i) => ({ ...shard.stops[0], name: `文化路${i}號`, garbage: [{ days: 1 << (i >= 245 ? 5 : 1), start: i >= 245 ? '19:05' : '16:30', end: '' }] }));
  const raw = encodeShard({ v: 2, stops });
  const svc = createGarbageService({ index: async () => index, shard: async (_c, _g, d, k, filter) => decodeShard(raw, d, k, filter) });
  const query = { city: '新北', district: '板橋', keyword: '文化路' };
  const result = await svc.schedule({ ...query, weekday: '週五', time: '19:05' });
  expect(result.text).toContain('共 5 個收運點');
  expect(result.text).toContain('文化路249號');
  expect(result.text).not.toContain('超過 200 筆');
  expect((await svc.schedule({ ...query, time: '20:00' })).text).toContain('有收運點，但不符合指定的星期或時間');
  expect((await svc.schedule(query)).text).toContain('超過 200 個收運點');
});

it('truncates after 1000 keyword matches even when few stops pass the filter', async () => {
  const stops = Array.from({ length: 1100 }, (_, i) => ({ ...shard.stops[0], name: `文化路${i}號` }));
  const raw = encodeShard({ v: 2, stops });
  expect(decodeShard(raw, '板橋區', '文化路', () => false)).toEqual({ v: 2, stops: [], truncated: true, matched: 1001 });
  expect(decodeShard(encodeShard({ v: 2, stops: stops.slice(0, 1000) }), '板橋區', '文化路', () => false)).toEqual({ v: 2, stops: [], matched: 1000 });
  for (const count of [0, 2]) {
    const svc = createGarbageService({ index: async () => index, shard: async () => ({ v: 2, stops: stops.slice(0, count), truncated: true }) });
    const text = (await svc.schedule({ city: '新北', district: '板橋', keyword: '文化路' })).text;
    expect(text).toContain('符合的收運點太多，請加上里名、路段或時間縮小範圍。');
    expect(text).not.toContain('超過 200');
    if (count) expect(text).toContain('符合太多收運點，以下列出部分結果');
    expect(text.match(/文化路\d+號（文化里，路線 A1）/g) ?? []).toHaveLength(count);
  }
});

it('strips the supplied district from the keyword', async () => {
  for (const keyword of ['板橋文化路', '板橋區文化路']) {
    expect((await service.schedule({ city: '新北', district: '板橋', keyword })).text).toContain('文化路１號');
  }
});


it('preserves road names beginning with a short district name and falls back to stripped keywords', async () => {
  const entry = { ...index.cities.ntpc!, districts: { 中山區: { stops: 1, sha256: 'a'.repeat(64) } } };
  const road: Shard = { v: 2, stops: [{ ...shard.stops[0], district: '中山區', name: '中山北路2段1號' }] };
  const calls: string[] = [];
  const svc = createGarbageService({ index: async () => ({ ...index, cities: { taipei: entry } }), shard: async (_c, _g, d, k, filter) => { calls.push(k); return decodeShard(encodeShard(road), d, k, filter); } });
  for (const keyword of ['中山路', '中山北路']) {
    const result = await svc.schedule({ city: '台北', district: '中山', keyword });
    if (keyword === '中山北路') expect(result.text).toContain('中山北路2段1號');
    else expect(result.text).not.toContain('關鍵字太短或無效');
  }
  expect((await svc.schedule({ city: '台北', keyword: '中山北路' })).text).toContain('中山北路2段1號');
  expect(calls).toEqual(['中山路', '中山北路', '中山北路']);

  const bridgeCalls: string[] = [];
  const bridge = createGarbageService({ index: async () => index, shard: async (_c, _g, d, k, filter) => { bridgeCalls.push(k); return decodeShard(encodeShard(shard), d, k, filter); } });
  expect((await bridge.schedule({ city: '新北', district: '板橋', keyword: '板橋文化路' })).text).toContain('文化路１號');
  expect(bridgeCalls).toEqual(['板橋文化路', '文化路']);
});
