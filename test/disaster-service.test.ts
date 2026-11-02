import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { createDisasterService, type DisasterStore } from '../src/core/disaster/service.js';
import { counties } from '../src/core/outage/districts.js';
import { parseDgpa, parseNcdrJson, parseCap } from '../src/core/disaster/parse.js';
import type { Alert, Dgpa, Index } from '../src/core/disaster/model.js';
import { fixture, htmlFiles, none, json, wind, earthquake, at, state, index } from './disaster-fixtures.js';
function setup(html = none, date?: string) {
  const { updatedAt, ...snapshot } = parseDgpa(html), now = date ?? updatedAt;
  const worker = index({ dgpa: state({ lastSuccessAt: updatedAt, fetchedAt: updatedAt, sourceUpdatedAt: updatedAt, count: Object.keys(snapshot.counties).length }), ncdr: state({ sourceUpdatedAt: at, empty: true }) });
  const shards = new Map<string, Dgpa | Alert[]>([['dgpa', snapshot], ['ncdr', []]]);
  const indexes: { worker: Index | null; gha: Index | null } = { worker, gha: null };
  const store: DisasterStore = { indexes: async () => indexes, shard: async source => shards.get(source) ?? null };
  return { service: createDisasterService(store, () => new Date(now)), store, worker, indexes, shards };
}
it.each(htmlFiles)('formats DGPA %s as dated official text and never invents 照常', async file => {
  const html = fixture(file), { service } = setup(html), parsed = parseDgpa(html);
  for (const county of counties) {
    const result = await service.closure({ city: county });
    expect(result.isError).toBe(false); expect(result.text).toContain('https://www.dgpa.gov.tw/typh/daily/nds.html');
    expect(result.text).toContain('官方頁面更新時間：'); expect(result.text).toContain('本服務抓取時間：');
    if (result.text.includes('照常')) expect(parsed.counties[county]?.some(s => s.includes('照常'))).toBe(true);
    if (parsed.noEvent) expect(result.text).toContain('官方頁面：「無停班停課訊息。」');
    else if (!parsed.counties[county]) expect(result.text).toContain('官方頁面未列本縣市');
    else for (const line of parsed.counties[county]) expect(result.text).toContain(`「${line}」`);
  }
});
it('shows today/tomorrow dates and unmarked announcements without rewriting official lines', async () => {
  const { service } = setup(fixture('dgpa-nds-2026-10-22-1856-live-event-wayback.html'));
  const taipei = await service.closure({ city: '臺北市' }); expect(taipei.text).toContain('10/22（今天）'); expect(taipei.text).toContain('10/23（明天）'); expect(taipei.text).toContain('未標明日期：\n「尚未宣布消息」');
  const hsinchu = await service.closure({ city: '新竹' }); expect(hsinchu.text).toContain('「新竹」可能指新竹市或新竹縣，以下兩者都列出。'); expect(hsinchu.text.indexOf('新竹市 天然')).toBeLessThan(hsinchu.text.indexOf('新竹縣 天然'));
  const all = await service.closure({ city: '新竹市' }); expect(all.text).toContain('10/23（明天）：\n「明天停止上班、停止上課。」');
});
it('retains school exceptions and withholds stale 照常 lines while retaining stopping lines', async () => {
  const html = fixture('dgpa-nds-2026-08-25-archive.html'), parsed = parseDgpa(html);
  const { service } = setup(html, new Date(Date.parse(parsed.updatedAt) + 91 * 60000).toISOString());
  const result = await service.closure({ city: '花蓮縣' });
  expect(result.text.startsWith('⚠️ 資料可能過期')).toBe(true); expect(result.text).not.toContain('「今天照常上班、照常上課。」');
  expect(result.text).toContain('（此行原文含「照常」，因資料可能過期不予顯示，請查官方頁面）');
  expect(result.text).toContain('「秀林鄉銅門部落(銅門村7~14鄰):今天停止上班、停止上課。」');
});
it('flags old DGPA page update even with a fresh fetch, preserves relative page dates and notes recent failures', async () => {
  const html = fixture('dgpa-nds-2026-10-22-1856-live-event-wayback.html'); const s = setup(html, at);
  s.worker.sources.dgpa!.lastSuccessAt = at;
  const old = await s.service.closure({ city: '桃園市' }); expect(old.text).toContain('注意：官方頁面日期為 2026-10-22，與今天不同。'); expect(old.text).toContain('10/22（2026-10-22）'); expect(old.text).toContain('⚠️'); expect(old.text).not.toContain('起照常上班');
  const fresh = setup(none, at); fresh.worker.sources.dgpa!.ok = false; fresh.worker.sources.dgpa!.reason = '來源連線失敗';
  const failed = await fresh.service.closure({ city: '臺北市' }); expect(failed.text).toContain('最近一次抓取失敗，以下為 08:58 的資料。'); expect(failed.text).not.toContain('⚠️');
});
it('returns unavailable for missing/undecodable shards and no successful snapshot without inventing normal operation', async () => {
  const s = setup(); s.shards.delete('dgpa');
  const result = await s.service.closure({ city: '臺北市' }); expect(result.isError).toBe(false); expect(result.text).toContain('目前無法取得人事行政總處'); expect(result.text).not.toContain('照常');
  s.indexes.worker = null; expect((await s.service.closure({ city: '臺北市' })).text).toContain('尚無成功取得的資料');
  s.store.shard = async () => { throw Error('bad shard'); }; expect((await s.service.closure({ city: '臺北市' })).text).toContain('目前無法取得');
});
it('merges latest successful writer and reports its independent data time, ignoring skipped attempts', async () => {
  const s = setup(none, at); s.worker.sources.dgpa = state({ count: 0, lastSuccessAt: '2026-11-02T09:00:00+08:00' });
  s.indexes.gha = index({ dgpa: state({ count: 0, lastSuccessAt: '2026-11-02T09:10:00+08:00', sourceUpdatedAt: '2026-11-02T09:08:22+08:00' }) }, 'gha');
  let result = await s.service.closure({ city: '臺北市' }); expect(result.text).toContain('本服務抓取時間：2026-11-02 09:10'); expect(result.text).toContain('官方頁面更新時間：2026-11-02 09:08:22');
  s.worker.sources.dgpa = { ...s.worker.sources.dgpa, skipped: true, ok: false, fetchedAt: '2026-11-02T09:14:00+08:00' };
  result = await s.service.closure({ city: '臺北市' }); expect(result.text).not.toContain('最近一次抓取失敗');
});
it.each([['台 北 市信義區', '臺北市'], ['臺北縣板橋市', '新北市'], ['桃園縣復興鄉', '桃園市'], ['臺中縣大甲鎮', '臺中市'], ['臺南縣新營市', '臺南市'], ['高雄縣鳳山市', '高雄市'], ['嘉義', '嘉義市']])('canonicalizes %s', async (input, expected) => { expect((await setup().service.closure({ city: input })).text).toContain(`${expected} 天然`); });
it('rejects unknown cities with all 22 counties and an official link', async () => { const result = await setup().service.closure({ city: '火星' }); expect(result.isError).toBe(true); for (const county of counties) expect(result.text).toContain(county); expect(result.text).toContain('https://'); });
const alerts = (): Alert[] => parseNcdrJson(json).entries.map(({ status: _, msgType: __, ...e }) => e);
it('distinguishes no active alerts, source failure, expired alerts and a closed source overriding old data', async () => {
  const s = setup(none, at); s.worker.sources.ncdr!.count = 0;
  expect((await s.service.alerts({ city: '臺北市' })).text).toContain('目前沒有臺北市生效中的告警');
  s.shards.delete('ncdr'); expect((await s.service.alerts({ city: '臺北市' })).text).toContain('目前無法取得 NCDR');
  s.shards.set('ncdr', alerts().map(e => ({ ...e, expires: '2026-11-02T01:00:00+08:00', detail: true, complete: true }))); s.worker.sources.ncdr!.count = 3;
  expect((await s.service.alerts({ city: '新竹' })).text).toContain('目前沒有新竹市生效中的告警');
  s.indexes.gha = index({ ncdr: { ok: false, closed: true, fetchedAt: '2026-11-02T09:16:00+08:00', reason: '請先登入會員。' } }, 'gha');
  const closed = await s.service.alerts({ city: '新竹' }); expect(closed.text).toContain('disaster_alerts 尚未支援'); expect(closed.text).toContain('本服務不使用金鑰'); expect(closed.text).not.toContain('目前沒有'); expect(closed.text).toContain('來源更新時間：');
});
it('sorts severity then effective, labels earthquake/water, limits output, and shows source times and missing details', async () => {
  const s = setup(none, at), base = alerts()[0];
  const entries: Alert[] = Array.from({ length: 23 }, (_, i) => ({ ...base, id: String(i), title: `公告${i}`, type: i === 0 ? '地震' : i === 1 ? '停水' : '強風', severity: i < 2 ? 'Extreme' : 'Minor', counties: ['臺北市'], effective: '2026-11-02T08:00:00+08:00' }));
  s.shards.set('ncdr', entries); s.worker.sources.ncdr!.count = entries.length;
  const result = await s.service.alerts({ city: '臺北市' });
  expect(result.text).toContain('【地震】公告0（地震資訊以中央氣象署為準）'); expect(result.text).toContain('【停水】公告1（停水詳情可用 outage_schedule 查詢）'); expect(result.text).toContain('等級：極嚴重'); expect(result.text).toContain('尚未取得 CAP 詳細資料'); expect(result.text).toContain('另有 3 則'); expect(result.text).toContain(base.link); expect(result.text).toContain('本服務抓取時間：2026-11-02 09:15');
  const stale = createDisasterService(s.store, () => new Date('2026-11-02T11:00:00+08:00')); expect((await stale.alerts({ city: '臺北市' })).text.startsWith('⚠️')).toBe(true);
});
it('calls both formatted tools through MCP and validates city length', async () => {
  const s = setup(); const server = createServer({ toolsets: ['disaster'], disasterStore: s.store, clock: () => new Date(at) });
  const client = new Client({ name: 'test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['work_school_closure', 'disaster_alerts']);
    for (const name of ['work_school_closure', 'disaster_alerts']) { const reply = await client.callTool({ name, arguments: { city: '臺北市' } }); expect(reply.isError).not.toBe(true); expect(JSON.stringify(reply.content)).not.toContain('[object Object]'); expect(JSON.stringify(reply.content)).toContain('https://'); }
    expect((await client.callTool({ name: 'disaster_alerts', arguments: { city: 'x'.repeat(31) } })).isError).toBe(true);
  } finally { await client.close(); }
});
it('loads only the source requested by each service tool', async () => {
  const s = setup(), indexes = vi.spyOn(s.store, 'indexes');
  await s.service.closure({ city: '臺北市' }); await s.service.alerts({ city: '臺北市' });
  expect(indexes.mock.calls).toEqual([['dgpa'], ['ncdr']]);
});
it('shows a summary-only 綠島 alert for 臺東縣', async () => {
  const s = setup(none, at); s.shards.set('ncdr', alerts()); s.worker.sources.ncdr!.count = 3;
  const result = await s.service.alerts({ city: '臺東縣' });
  expect(result.text).toContain('【強風】'); expect(result.text).toContain('尚未取得 CAP 詳細資料'); expect(result.text).not.toContain('目前沒有');
});
it('lists up to five active alerts with unknown geography instead of asserting absence', async () => {
  const s = setup(none, at), base = alerts()[0];
  const entries = Array.from({ length: 7 }, (_, i) => ({ ...base, id: String(i), title: `未知範圍${i}`, counties: [], link: `https://alerts.ncdr.nat.gov.tw/${i}.cap` }));
  const inactive = [
    { ...base, id: 'expired', counties: [], expires: at },
    { ...base, id: 'future', counties: [], effective: '2026-11-02T10:00:00+08:00' },
    { ...base, id: 'detailed', counties: [], detail: true },
  ];
  s.shards.set('ncdr', [...entries, ...inactive]); s.worker.sources.ncdr!.count = 10;
  const result = await s.service.alerts({ city: '新竹' });
  for (const county of ['新竹市', '新竹縣']) expect(result.text).toContain(`${county}：有 9 則告警無法確認是否涵蓋本縣市：`);
  for (const item of entries.slice(0, 5)) { expect(result.text).toContain(`【強風】${item.title}`); expect(result.text).toContain(`連結：${item.link}`); }
  expect(result.text).toContain('另有 4 則'); expect(result.text).not.toContain('未知範圍5'); expect(result.text).not.toContain('目前沒有');
});
it('appends unknown-geography counts alongside county-matched alerts', async () => {
  const s = setup(none, at), base = alerts()[0];
  s.shards.set('ncdr', [{ ...base, counties: ['臺北市'] }, { ...base, id: 'unknown', counties: [] }]); s.worker.sources.ncdr!.count = 2;
  const result = await s.service.alerts({ city: '臺北市' });
  expect(result.text).toContain('臺北市 生效中的災防告警');
  expect(result.text).toContain('臺北市：有 1 則告警無法確認是否涵蓋本縣市：');
});
it('shows county-specific CAP areas including those beyond the old thirty-area limit', async () => {
  const s = setup(none, at), { status: _, msgType: __, ...cap } = parseCap(wind);
  s.shards.set('ncdr', [{ ...cap, link: alerts()[0].link, detail: true }]); s.worker.sources.ncdr!.count = 1;
  const result = await s.service.alerts({ city: '連江縣' });
  expect(result.text).toContain('範圍：連江縣東引鄉、連江縣北竿鄉、連江縣莒光鄉、連江縣南竿鄉'); expect(result.text).not.toMatch(/範圍：.*桃園市/);
});
it('limits detailed area output to fifteen, canonicalizes county aliases and omits empty/summary areas', async () => {
  const s = setup(none, at), base = { ...alerts()[0], counties: ['臺北市'], detail: true };
  const areas = Array.from({ length: 17 }, (_, i) => `台北市範圍${i}`);
  s.shards.set('ncdr', [{ ...base, areas: ['新北市板橋區', ...areas] }]); s.worker.sources.ncdr!.count = 1;
  const result = await s.service.alerts({ city: '臺北市' });
  expect(result.text).toContain(`範圍：${areas.slice(0, 15).join('、')}等 17 處`); expect(result.text).not.toContain('台北市範圍15');
  for (const patch of [{ areas: ['新北市板橋區'] }, { areas, detail: false }]) {
    s.shards.set('ncdr', [{ ...base, ...patch }]); expect((await s.service.alerts({ city: '臺北市' })).text).not.toContain('範圍：');
  }
});
it.each([[], alerts().map(e => ({ ...e, expires: at })), [{ ...alerts()[0], counties: [] }]].map(entries => ({ entries })))('never asserts no active alerts from stale data %#', async ({ entries }) => {
  const s = setup(none, at); s.shards.set('ncdr', entries); s.worker.sources.ncdr!.count = entries.length;
  const result = await createDisasterService(s.store, () => new Date(Date.parse(at) + 91 * 60000)).alerts({ city: '新竹' });
  expect(result.text.startsWith('⚠️')).toBe(true); expect(result.text).not.toContain('目前沒有');
  for (const county of ['新竹市', '新竹縣']) expect(result.text).toContain(`資料已過期（2026-11-02 09:15），無法確認${county}目前是否有告警，請至 https://alerts.ncdr.nat.gov.tw/ 查詢。`);
});
it.each(['fetch', 'page'])('qualifies stale no-event DGPA text when %s is older than ninety minutes', async cause => {
  const s = setup(none, at);
  s.worker.sources.dgpa!.lastSuccessAt = cause === 'fetch' ? '2026-11-02T07:44:00+08:00' : at;
  s.worker.sources.dgpa!.sourceUpdatedAt = cause === 'page' ? '2026-11-02T07:44:00+08:00' : at;
  const result = await s.service.closure({ city: '臺北市' });
  expect(result.text.startsWith('⚠️')).toBe(true);
  expect(result.text).toContain('資料已過期，官方頁面當時顯示「無停班停課訊息。」，目前狀態請查官方頁面。'); expect(result.text).not.toContain('官方頁面：「無停班停課訊息。」');
});

it.each(['sourceUpdatedAt', 'lastSuccessAt'] as const)('checks %s age and clock skew for both tools', async key => {
  for (const minutes of [-1500, -91, 10, 3]) {
    const s = setup(none, at);
    for (const source of ['ncdr', 'dgpa'] as const) s.worker.sources[source]![key] = new Date(Date.parse(at) + minutes * 60000).toISOString();
    const alert = (await s.service.alerts({ city: '臺北市' })).text;
    const closure = (await s.service.closure({ city: '臺北市' })).text;
    if (minutes === 3) { expect(alert).toContain('目前沒有'); expect(closure).toContain('官方頁面：「無停班停課訊息。」'); }
    else {
      if (key === 'sourceUpdatedAt' && minutes === -91) expect(alert).toContain('目前沒有');
      else expect(alert).not.toContain('目前沒有');
      expect(alert).toContain('https://alerts.ncdr.nat.gov.tw/');
      expect(closure).not.toContain('官方頁面：「無停班停課訊息。」');
      if (minutes === 10) { expect(alert).toContain('資料時間異常'); expect(closure).toContain('資料時間異常'); }
    }
  }
});
it('uses successful fetch freshness during quiet feeds, requiring a source timestamp', async () => {
  const s = setup(none, at); s.worker.sources.ncdr!.sourceUpdatedAt = new Date(Date.parse(at) - 89 * 60000).toISOString();
  expect((await s.service.alerts({ city: '臺北市' })).text).toContain('目前沒有');
  const later = createDisasterService(s.store, () => new Date(Date.parse(at) + 90 * 60000));
  expect((await later.alerts({ city: '臺北市' })).text).not.toContain('目前沒有');
  delete s.worker.sources.ncdr!.sourceUpdatedAt;
  expect((await s.service.alerts({ city: '臺北市' })).text).not.toContain('目前沒有');
});
it('shows latest cross-writer failure and retains known alerts, even with fresh chosen data', async () => {
  const s = setup(none, at); const item = { ...alerts()[0], counties: ['臺北市'], detail: true, complete: true };
  s.shards.set('ncdr', [item]); s.worker.sources.ncdr!.count = 1;
  s.indexes.gha = index({ ncdr: { ok: false, fetchedAt: new Date(Date.parse(at) + 1000).toISOString(), reason: 'timeout' } }, 'gha');
  for (const city of ['臺北市', '高雄市']) {
    const text = (await s.service.alerts({ city })).text;
    expect(text).toContain(`最近一次抓取失敗（timeout），無法確認${city}目前是否有告警，請至 https://alerts.ncdr.nat.gov.tw/ 查詢。`);
    expect(text).not.toContain('目前沒有');
    if (city === '臺北市') expect(text).toContain('【強風】');
  }
});
it('requires verified empty evidence and treats missing geographic completeness as incomplete', async () => {
  const s = setup(none, at); delete s.worker.sources.ncdr!.empty;
  expect((await s.service.alerts({ city: '臺北市' })).text).not.toContain('目前沒有');
  for (const patch of [{ detail: true, counties: [] }, { detail: false, counties: ['臺東縣'] }, { detail: true, counties: ['臺東縣'] }]) {
    s.shards.set('ncdr', [{ ...alerts()[0], ...patch }]); s.worker.sources.ncdr!.count = 1;
    const text = (await s.service.alerts({ city: '臺北市' })).text;
    expect(text).toContain('有 1 則告警無法確認是否涵蓋本縣市'); expect(text).not.toContain('目前沒有');
  }
});
it('shows upcoming alerts with local effective time and a qualified active-absence message', async () => {
  const s = setup(none, at);
  s.shards.set('ncdr', [{ ...alerts()[0], counties: ['臺北市'], detail: true, complete: true, effective: '2026-11-02T02:00:00Z' }]); s.worker.sources.ncdr!.count = 1;
  const text = (await s.service.alerts({ city: '臺北市' })).text;
  expect(text).toContain('目前沒有臺北市生效中的告警，但有 1 則即將生效：');
  expect(text).toContain('臺北市 即將生效的告警'); expect(text).toContain('即將生效：2026-11-02 10:00（臺北時間）');
});
it('selects source revision before fetch completion time, then uses success time as tie-breaker', async () => {
  const s = setup(none, at); s.worker.sources.ncdr!.sourceUpdatedAt = '2026-11-02T09:14:00+08:00';
  s.worker.sources.ncdr!.lastSuccessAt = '2026-11-02T09:14:00+08:00';
  s.indexes.gha = index({ ncdr: state({ empty: true, lastSuccessAt: at, sourceUpdatedAt: '2026-11-02T09:10:00+08:00' }) }, 'gha');
  expect((await s.service.alerts({ city: '臺北市' })).text).toContain('本服務抓取時間：2026-11-02 09:14');
  s.indexes.gha.sources.ncdr!.sourceUpdatedAt = '2026-11-02T09:14:00+08:00';
  expect((await s.service.alerts({ city: '臺北市' })).text).toContain('本服務抓取時間：2026-11-02 09:15');
});
it.each([['花蓮市', '花蓮縣'], ['屏東市', '屏東縣'], ['宜蘭市', '宜蘭縣'], ['台東市', '臺東縣'], ['竹北市', '新竹縣'], ['頭份市', '苗栗縣']])('maps %s to its county in both tools', async (city, county) => {
  const s = setup(none, at);
  for (const tool of [s.service.closure, s.service.alerts]) expect((await tool({ city })).text).toContain(`「${city}」屬${county}，以下顯示${county}。`);
});
it('caps both tools at 16KiB UTF-8 on line boundaries and retains source attribution', async () => {
  const s = setup(none, at), base = alerts()[0];
  const many = Array.from({ length: 20 }, (_, i) => ({ ...base, id: String(i), counties: ['新竹市', '新竹縣'], title: '長'.repeat(200), text: '長'.repeat(400), link: 'https://bad.example/alert' }));
  s.shards.set('ncdr', many); s.worker.sources.ncdr!.count = many.length;
  s.shards.set('dgpa', { pageDate: '2026-11-02', layout: 'flat', noEvent: false, counties: { 新竹市: Array(20).fill('長'.repeat(300)), 新竹縣: Array(20).fill('長'.repeat(300)) } }); s.worker.sources.dgpa!.count = 2;
  for (const tool of [s.service.closure, s.service.alerts]) {
    const text = (await tool({ city: '新竹' })).text;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16384); expect(text).toContain('內容過長已截斷');
    expect(text).toContain('來源：'); expect(text).not.toContain('bad.example');
  }
});
it.each(['http://alerts.ncdr.nat.gov.tw/a', 'https://alerts.ncdr.nat.gov.tw:443/a', 'https://user@alerts.ncdr.nat.gov.tw/a', 'https://evil.example/a', `https://alerts.ncdr.nat.gov.tw/${'a'.repeat(300)}`])('emits only the official fallback for an unsafe alert link %s', async link => {
  const s = setup(none, at); s.shards.set('ncdr', [{ ...alerts()[0], counties: ['臺北市'], link }]); s.worker.sources.ncdr!.count = 1;
  const text = (await s.service.alerts({ city: '臺北市' })).text;
  expect(text).toContain('連結：https://alerts.ncdr.nat.gov.tw/\n'); expect(text).not.toContain(`連結：${link}\n`);
});
it('requires a recorded non-skipped attempt, and treats tied failed attempts conservatively', async () => {
  const s = setup(none, at); s.worker.sources.ncdr!.skipped = true;
  let text = (await s.service.alerts({ city: '臺北市' })).text;
  expect(text).toContain('缺少最近一次抓取狀態'); expect(text).not.toContain('目前沒有');
  s.worker.sources.ncdr!.skipped = false;
  s.indexes.gha = index({ ncdr: { ok: false, fetchedAt: at, reason: 'timeout' } }, 'gha');
  text = (await s.service.alerts({ city: '臺北市' })).text;
  expect(text).toContain('最近一次抓取失敗（timeout）'); expect(text).not.toContain('目前沒有');
});

it('shows real earthquake coverage and county-specific intensity areas, allowing absence outside geocodes', async () => {
  const cap = parseCap(earthquake), when = cap.effective!;
  const s = setup(none, when);
  const { status: _, msgType: __, onset: ___, web: ____, ...detail } = cap;
  s.shards.set('ncdr', [{ ...detail, detail: true, link: 'https://alerts.ncdr.nat.gov.tw/eq.cap' }]);
  s.worker.sources.ncdr = state({ count: 1, sourceUpdatedAt: when, lastSuccessAt: when, fetchedAt: when });
  for (const city of ['花蓮縣', '臺北市']) {
    const text = (await s.service.alerts({ city })).text;
    expect(text).toContain('【地震】'); expect(text).not.toContain('目前沒有');
    expect(text).toContain(`範圍：最大震度${city === '花蓮縣' ? 3 : 2}級地區`);
  }
  for (const city of ['澎湖縣', '金門縣']) expect((await s.service.alerts({ city })).text).toContain(`目前沒有${city}生效中的告警`);
});
it.each(['地震', '颱風', '海嘯'])('treats summary-only %s alerts as undetermined for unnamed counties', async type => {
  const s = setup(none, at), item = { ...alerts()[0], type, title: `${type}資訊`, counties: ['宜蘭縣'], detail: false, complete: false };
  s.shards.set('ncdr', [item]); s.worker.sources.ncdr!.count = 1;
  const text = (await s.service.alerts({ city: '花蓮縣' })).text;
  expect(text).toContain('無法確認是否涵蓋本縣市'); expect(text).not.toContain('目前沒有');
});
it.each([['花蓮市', '花蓮縣'], ['馬祖', '連江縣']])('resolves %s to %s for both tools', async (city, county) => {
  const s = setup(none, at);
  for (const tool of [s.service.closure, s.service.alerts]) expect((await tool({ city })).text).toContain(`「${city}」屬${county}`);
  expect((await s.service.alerts({ city: '金馬' })).isError).toBe(true);
});
it('reports corrupt indexes distinctly and does not claim absence with an unreadable peer', async () => {
  const s = setup(none, at);
  s.store.indexes = async () => ({ worker: s.worker, gha: null, error: true });
  for (const tool of [s.service.closure, s.service.alerts]) {
    const text = (await tool({ city: '臺北市' })).text;
    expect(text).toContain('索引無法解讀'); expect(text).not.toContain('尚無成功取得的資料'); expect(text).not.toContain('目前沒有');
  }
});
it('accepts a three-hour source with a fresh fetch, but makes 25-hour source evidence unusable', async () => {
  const s = setup(none, at);
  for (const hours of [3, 25]) {
    s.worker.sources.ncdr!.sourceUpdatedAt = new Date(Date.parse(at) - hours * 3600000).toISOString();
    const text = (await s.service.alerts({ city: '臺北市' })).text;
    if (hours === 3) expect(text).toContain('目前沒有');
    else { expect(text).toContain('24 小時'); expect(text).not.toContain('目前沒有'); }
  }
});
