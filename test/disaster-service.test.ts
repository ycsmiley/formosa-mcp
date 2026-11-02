import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { createDisasterService, type DisasterStore } from '../src/core/disaster/service.js';
import { counties } from '../src/core/outage/districts.js';
import { parseDgpa, parseNcdrJson } from '../src/core/disaster/parse.js';
import type { Alert, Dgpa, Index } from '../src/core/disaster/model.js';
import { fixture, htmlFiles, none, json, at, state, index } from './disaster-fixtures.js';
function setup(html = none, date?: string) {
  const { updatedAt, ...snapshot } = parseDgpa(html), now = date ?? updatedAt;
  const worker = index({ dgpa: state({ lastSuccessAt: updatedAt, fetchedAt: updatedAt, sourceUpdatedAt: updatedAt, count: Object.keys(snapshot.counties).length }), ncdr: state({ sourceUpdatedAt: at }) });
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
  s.shards.set('ncdr', alerts().map(e => ({ ...e, expires: '2026-11-02T01:00:00+08:00' }))); s.worker.sources.ncdr!.count = 3;
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
