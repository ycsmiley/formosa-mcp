import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { createOutageService, reminder, relevantSources, type OutageStore } from '../src/core/outage/service.js';
import { type Index, type Item, type Source } from '../src/core/outage/model.js';
import { taipeiwater, taiwater, taiwaterEmptyReason, taipower } from '../src/core/outage/normalize.js';
import { fixture, powerCsv } from './outage-fixtures.js';
import { dailyTimes } from '../src/core/outage/time.js';
const now = () => new Date('2026-11-01T00:00:00Z');
const all = [...taipeiwater(JSON.parse(fixture('taipeiwater.json'))), ...taiwater(JSON.parse(fixture('taiwater.json'))), ...taipower(new Map([['101.csv', powerCsv()]]), 1).items];
function setup(items = all, time = now().toISOString()) {
  const index: Index = { v: 1, generatedAt: time, sources: {} };
  for (const source of ['taiwater', 'taipeiwater', 'taipower'] as Source[]) index.sources[source] = { ok: true, fetchedAt: time, lastSuccessAt: time, counties: Object.fromEntries(items.filter(i => i.s === source).map(i => [i.c, { sha: 'a'.repeat(64), count: items.filter(x => x.s === source && x.c === i.c).length, writtenAt: time }])) };
  const store: OutageStore = { index: async () => index, shard: async (s, c) => items.filter(i => i.s === s && i.c === c) };
  return { index, store, service: createOutageService(store, now) };
}
it('formats real matches, two windows, source office/link/phone and acquisition time in Chinese', async () => {
  const { service } = setup(); const { text } = await service.schedule({ city: '台北', district: '信義區', type: 'power' });
  for (const expected of ['臺北市信義區', '🔌 停電｜11/05（四）23:20–11/06（五）00:49', '11/06（五）10:00–11:00', '松仁路', '請求號數 T1', '台電台北區營業處', '/branch/d101', '查詢電話 1911', '2026-11-01 08:00（臺北時間）', 'OGDL-1', reminder]) expect(text).toContain(expected);
});
it('filters keywords, uses date overlap across midnight and preserves unparseable water dates', async () => {
  const { service } = setup();
  expect((await service.schedule({ city: '臺北市', type: 'power', keyword: '不存在' })).text).not.toContain('🔌');
  expect((await service.schedule({ city: '臺北市', type: 'power', keyword: '松仁', start_date: '2026-11-06', end_date: '2026-11-06' })).text).toContain('🔌');
  expect((await service.schedule({ city: '雲林縣', type: 'water', start_date: '2026-11-20', end_date: '2026-11-20' })).text).toContain('待確認～另行公告（官方時間原文）');
  expect((await service.schedule({ city: '臺北市', type: 'power', start_date: '2026-11-04', end_date: '2026-11-04' })).text).not.toContain('🔌');
  const raw = (await service.schedule({ city: '臺北市', type: 'water', keyword: '松仁' })).text; expect(raw).toContain('另行公告'); expect(raw).toContain('北水');
});
it('matches keywords within each requested district segment and falls back when it is absent', async () => {
  const base = all.find(i => i.s === 'taipeiwater' && i.c === '臺北市')!;
  const area = '臺北市中山區民生東路、大安區和平東路、中山區林森北路';
  const { service } = setup([{ ...base, d: '中山區', a: area }, { ...base, d: '大安區', a: area }, { ...base, d: '信義區', a: area }]);
  for (const keyword of ['民生東路', '林森北路']) expect((await service.schedule({ city: '臺北市', district: '中山區', type: 'water', keyword })).text).toContain('💧');
  expect((await service.schedule({ city: '臺北市', district: '中山區', type: 'water', keyword: '和平東路' })).text).not.toContain('💧');
  expect((await service.schedule({ city: '臺北市', district: '信義區', type: 'water', keyword: '和平東路' })).text).toContain('💧');
  expect((await service.schedule({ city: '臺北市', type: 'water', keyword: '和平東路' })).text).toContain('💧');
});
it('shows only overlapping windows, then compresses consecutive daily hours within the query', async () => {
  const base = all.find(i => i.s === 'taipeiwater')!, item = { ...base, t: dailyTimes('115年11月01日~115年11月08日', '10:00~16:00') };
  const { service } = setup([item]);
  const range = (await service.schedule({ city: '臺北市', type: 'water', start_date: '2026-11-02', end_date: '2026-11-07' })).text;
  expect(range).toContain('💧 停水｜11/02（一）～11/07（六）每日 10:00–16:00'); expect(range).not.toContain('11/01（日）'); expect(range).not.toContain('11/08（日）');
  const day = (await service.schedule({ city: '臺北市', type: 'water', start_date: '2026-11-03', end_date: '2026-11-03' })).text;
  expect(day).toContain('💧 停水｜11/03（二）10:00–16:00'); expect(day).not.toContain('每日');
  const power = (await setup().service.schedule({ city: '臺北市', type: 'power', start_date: '2026-11-05', end_date: '2026-11-05' })).text;
  expect(power).toContain('11/05（四）23:20–11/06（五）00:49'); expect(power).not.toContain('11/06（五）10:00');
  const midnight = setup([{ ...base, t: [['2026-11-01T23:00', '2026-11-02T00:00'], ['2026-11-03T00:00', '2026-11-03T01:00']] }]);
  expect((await midnight.service.schedule({ city: '臺北市', type: 'water', start_date: '2026-11-02', end_date: '2026-11-02' })).text).not.toContain('💧');
});
it('shows the Taipei Water reason fallback without repeating area text', async () => {
  const area = '臺北市中山區新生北路一段';
  for (const reason of [{ Title: ` ${area}\r\n`, Description: `${area}\n ` }, { Title: '', Description: ' \r\n' }]) {
    const items = taipeiwater([{ SW_Area: ` ${area}\r\n`, SW_No: ' N1\r\n', Date: '115年11月02日', Time: '10:00~16:00', ...reason }]);
    const { text } = await setup(items).service.schedule({ city: '臺北市', type: 'water' });
    expect(text).toContain('原因：北水公告未提供（案件編號 N1）'); expect(text.split(area)).toHaveLength(2); expect(text).not.toContain('\r');
  }
});
it('keeps a repeated county/district prefix once while preserving other districts and counties', async () => {
  const base = all.find(i => i.s === 'taipower' && i.c === '臺北市')!;
  for (const [area, expected] of [['臺北市中山區新生北路一段、臺北市中山區林森北路', '臺北市中山區新生北路一段、林森北路'], ['臺北市中山區新生北路一段、臺北市中山區林森北路；臺北市大安區和平東路；新北市永和區中正路', '臺北市中山區新生北路一段、林森北路；臺北市大安區和平東路；新北市永和區中正路'], ['臺北市中山區新生北路一段；臺北市大安區和平東路、臺北市中山區林森北路', '臺北市中山區新生北路一段；臺北市大安區和平東路、臺北市中山區林森北路']]) {
    const { text } = await setup([{ ...base, d: '中山區', a: area }]).service.schedule({ city: '臺北市', type: 'power' }); expect(text).toContain(`範圍：${expected}`);
  }
});
it('includes county-only power notices for any district and marks the missing district', async () => {
  expect((await setup().service.schedule({ city: '新竹市', district: '香山區', type: 'power' })).text).toContain('內湖里（未標示行政區）');
});
it('reports no match only for available sources and always includes the reminder', async () => {
  const { index, service } = setup(); index.sources.taiwater!.ok = false; index.sources.taiwater!.reason = taiwaterEmptyReason;
  const { text } = await service.schedule({ city: '新北市', keyword: '不存在' });
  expect(text).toContain('官方公告中查無 新北市 2026-11-01～2026-11-07 的計畫性停水／停電（關鍵字「不存在」）。'); expect(text).toContain('已查詢來源：北水、台電'); expect(text).toContain('台水官方開放資料目前是空的，結果可能不完整，請至 https://web.water.gov.tw/wateroff/ 自行查詢。'); expect(text.endsWith(reminder)).toBe(true);
});
it('does not claim no outages when Taiwan Water is empty from the start', async () => {
  const { index, service } = setup(); index.sources.taiwater = { ok: false, reason: taiwaterEmptyReason, counties: {} };
  const { text } = await service.schedule({ city: '新竹市', district: '東區', type: 'water' });
  expect(text).toContain('台水官方開放資料目前是空的，結果可能不完整，請至 https://web.water.gov.tw/wateroff/ 自行查詢。');
  expect(text).not.toContain('查無停水'); expect(text).not.toContain('官方公告中查無'); expect(text).not.toContain('已查詢來源');
});
it('warns on stale index or last successful collection even if this run failed', async () => {
  const { index, service } = setup(all, '2026-10-30T00:00:00Z');
  const warning = '⚠️ 資料可能過期（最後更新：台電 2026-10-30 08:00（臺北時間））';
  let text = (await service.schedule({ city: '臺北市', type: 'power' })).text; expect(text).toContain(warning); expect(text.match(/⚠️/g)).toHaveLength(1);
  index.generatedAt = now().toISOString(); index.sources.taipower!.ok = false; text = (await service.schedule({ city: '臺北市', type: 'power' })).text; expect(text).toContain(warning); expect(text.match(/⚠️/g)).toHaveLength(1);
});
it('combines stale sources in one line and uses the index time only when sources are fresh', async () => {
  const { index, service } = setup(all, '2026-10-30T00:00:00Z');
  const text = (await service.schedule({ city: '臺北市' })).text; expect(text.match(/⚠️/g)).toHaveLength(1); expect(text).toContain('最後更新：北水 2026-10-30 08:00、台電 2026-10-30 08:00（臺北時間））');
  for (const info of Object.values(index.sources)) info.lastSuccessAt = now().toISOString();
  const indexOnly = (await service.schedule({ city: '臺北市' })).text; expect(indexOnly.match(/⚠️/g)).toHaveLength(1); expect(indexOnly).toContain('⚠️ 資料可能過期（最後更新：2026-10-30 08:00（臺北時間））');
  index.generatedAt = now().toISOString(); expect((await service.schedule({ city: '臺北市' })).text).not.toContain('⚠️');
});
it('reports missing/broken index and missing/undecodable shards as unavailable', async () => {
  for (const broken of [false, true]) {
    const { store } = setup(); store.index = async () => { if (broken) throw Error(); return null; };
    const { text } = await createOutageService(store, now).schedule({ city: '新北市' }); expect(text.match(/該來源暫時無法取得/g)).toHaveLength(3); expect(text).not.toContain('官方公告中查無'); expect(text).toContain(reminder);
    const fixed = setup(); fixed.store.shard = async () => { if (broken) throw Error('decode'); return null; };
    expect((await fixed.service.schedule({ city: '臺北市', type: 'power' })).text).toContain('快照遺失或無法解讀');
  }
  const { index, service } = setup(); delete index.sources.taipower!.lastSuccessAt; expect((await service.schedule({ city: '臺北市', type: 'power' })).text).toContain('尚無成功取得');
});
it('uses the Taipei calendar date across the UTC day boundary', async () => {
  const { store } = setup(); const service = createOutageService(store, () => new Date('2026-11-01T17:00:00Z'));
  expect((await service.schedule({ city: '臺北市', type: 'power' })).text).toContain('2026-11-02～2026-11-08');
});
it('validates date arguments and accepts an inclusive 31-day span', async () => {
  const { service } = setup();
  for (const [start_date, end_date, message] of [['2026-02-30', '2026-03-02', '有效'], ['2026-11-03', '2026-11-02', '不可早於'], ['2026-11-01', '2026-12-02', '最多 31 天']]) expect(await service.schedule({ city: '臺北市', start_date, end_date })).toMatchObject({ isError: true, text: expect.stringContaining(message) });
  expect((await service.schedule({ city: '臺北市', start_date: '2026-11-01', end_date: '2026-12-01' })).isError).toBe(false);
});
it('limits output to 30 and deduplicates multi-district announcements', async () => {
  const base = all.find(i => i.s === 'taipower' && i.c === '臺北市')!;
  const items: Item[] = Array.from({ length: 33 }, (_, i) => ({ ...base, n: `job${i}` }));
  const reply = await setup(items).service.schedule({ city: '臺北市', type: 'power' }); expect(reply.text.match(/🔌/g)).toHaveLength(30); expect(reply.text).toContain('另有 3 筆，請縮小範圍');
  expect((await setup().service.schedule({ city: '臺北市', type: 'water', keyword: '民生東路' })).text.match(/💧/g)).toHaveLength(1);
});
it('selects utility coverage and explains Lienchiang without reading a power shard', async () => {
  expect(relevantSources('臺北市')).toEqual(['taipeiwater', 'taipower']); expect(relevantSources('新北市', 'water')).toEqual(['taipeiwater', 'taiwater']); expect(relevantSources('連江縣', 'power')).toEqual([]);
  const { store, service } = setup(); const shard = vi.spyOn(store, 'shard'); expect((await service.schedule({ city: '連江縣', type: 'power' })).text).toContain('台電開放資料未涵蓋連江縣'); expect(shard).not.toHaveBeenCalled();
});
it('registers the bounded MCP arguments, applies defaults and returns Chinese validation errors', async () => {
  const { store } = setup(), server = createServer({ toolsets: ['outage'], outageStore: store, clock: now });
  const client = new Client({ name: 'outage-test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tool = (await client.listTools()).tools[0]; expect(tool.name).toBe('outage_schedule'); expect(tool.description).toContain('計畫性');
    const result = await client.callTool({ name: 'outage_schedule', arguments: { city: '臺北市', start_date: '2026-11-05', end_date: '2026-11-01' } }); expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('不可早於');
    const match = await client.callTool({ name: 'outage_schedule', arguments: { city: '臺北市', keyword: '松仁' } }); expect(JSON.stringify(match.content)).toContain('松仁路');
    const long = await client.callTool({ name: 'outage_schedule', arguments: { city: '臺北市', keyword: '路'.repeat(101) } }); expect(long.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});

it('limits no-match wording to checked sources and warns about dropped power rows', async () => {
  const { index, service } = setup([]); index.sources.taiwater = { ok: false, reason: taiwaterEmptyReason, counties: {} };
  index.sources.taipower!.dropped = 3;
  const text = (await service.schedule({ city: '臺中市', type: 'all' })).text;
  expect(text).toContain('官方公告中查無 臺中市 2026-11-01～2026-11-07 的計畫性停電。');
  expect(text).toContain('已查詢來源：台電。');
  expect(text).toContain('另有 3 筆台電公告未標示縣市，未納入比對，請至 https://service.taipower.com.tw/ 確認。');
  expect((await service.schedule({ city: '臺中市', type: 'water' })).text).not.toContain('筆台電公告未標示縣市');
});
