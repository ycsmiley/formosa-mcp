import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { createOutageService, reminder, relevantSources, type OutageStore } from '../src/core/outage/service.js';
import { type Index, type Item, type Source } from '../src/core/outage/model.js';
import { taipeiwater, taiwater, taipower } from '../src/core/outage/normalize.js';
import { fixture, powerCsv } from './outage-fixtures.js';
const now = () => new Date('2026-11-01T00:00:00Z');
const all = [...taipeiwater(JSON.parse(fixture('taipeiwater.json'))), ...taiwater(JSON.parse(fixture('taiwater.json'))), ...taipower(new Map([['101.csv', powerCsv()]]), 1).items];
function setup(items = all, time = now().toISOString()) {
  const index: Index = { v: 1, generatedAt: time, sources: {} };
  for (const source of ['taiwater', 'taipeiwater', 'taipower'] as Source[]) index.sources[source] = { ok: true, fetchedAt: time, lastSuccessAt: time, counties: Object.fromEntries(items.filter(i => i.s === source).map(i => [i.c, { sha: 'a'.repeat(64), count: items.filter(x => x.s === source && x.c === i.c).length }])) };
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
it('includes county-only power notices for any district and marks the missing district', async () => {
  expect((await setup().service.schedule({ city: '新竹市', district: '香山區', type: 'power' })).text).toContain('內湖里（未標示行政區）');
});
it('reports no match only for available sources and always includes the reminder', async () => {
  const { index, service } = setup(); index.sources.taiwater!.ok = false; index.sources.taiwater!.reason = '官方開放資料目前回傳空清單';
  const { text } = await service.schedule({ city: '新北市', keyword: '不存在' });
  expect(text).toContain('官方公告中查無 新北市 2026-11-01～2026-11-07 的計畫性停水／停電（關鍵字「不存在」）。'); expect(text).toContain('已查詢來源：北水、台電'); expect(text).toContain('台水：該來源暫時無法取得（官方開放資料目前回傳空清單）'); expect(text.endsWith(reminder)).toBe(true);
});
it('warns on stale index or last successful collection even if this run failed', async () => {
  const { index, service } = setup(all, '2026-10-30T00:00:00Z'); expect((await service.schedule({ city: '臺北市', type: 'power' })).text).toContain('⚠️ 資料可能過期（最後更新');
  index.generatedAt = now().toISOString(); index.sources.taipower!.ok = false; expect((await service.schedule({ city: '臺北市', type: 'power' })).text).toContain('最後更新 台電');
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
