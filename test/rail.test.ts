import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerOptions } from '../src/mcp/server.js';
import { createRailService } from '../src/core/rail/service.js';
import { operatingTimes } from '../src/core/rail/time.js';
import { createTdxClient, railRowLimit, rejected, truncatedNote, unavailable, type RailHttp } from '../src/core/rail/client.js';
import { fixtureHttp, railFixture } from '../scripts/rail-fixtures.js';

const env = { TDX_CLIENT_ID: 'private-id-marker', TDX_CLIENT_SECRET: 'private-secret-marker' };
const credentials = { clientId: env.TDX_CLIENT_ID, clientSecret: env.TDX_CLIENT_SECRET };
const clock = () => new Date('2026-10-27T16:30:00Z');
const attribution = '資料介接「交通部TDX平臺」';
const args = { origin: '臺北', destination: '高雄', date: '2026-10-28', time: '00:00' };
const clients: { client: Client; server: ReturnType<typeof createServer> }[] = [];
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in rail tests')); });
afterEach(async () => { await Promise.all(clients.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); })); vi.restoreAllMocks(); });
async function setup(options: ServerOptions = {}) {
  const server = createServer({ toolsets: ['rail'], env, clock, railHttp: fixtureHttp, ...options });
  const client = new Client({ name: 'rail-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  clients.push({ client, server });
  await server.connect(a); await client.connect(b);
  return client;
}
async function call(client: Client, name: string, arguments_: Record<string, string> = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = (result.content as { text: string }[]).map(c => c.text).join('\n');
  expect(text).not.toMatch(/undefined|null|NaN|\[object|\{"/);
  return { ...result, text };
}
function service(http: RailHttp = fixtureHttp) { return createRailService({ credentials, http, clock }); }
const response = (value: unknown, status = 200) => ({ status, json: async () => value });

it('registers exactly three rail tools and all seven with explicit opt-in', async () => {
  expect((await (await setup()).listTools()).tools.map(t => t.name)).toEqual(['thsr_timetable', 'tra_timetable', 'tra_live']);
  const all = await setup({ toolsets: ['invoice', 'stock', 'rail'] });
  expect((await all.listTools()).tools).toHaveLength(7);
  const defaults = await setup({ toolsets: undefined });
  expect((await defaults.listTools()).tools.map(t => t.name)).not.toContain('tra_live');
});
it.each([{}, { TDX_CLIENT_ID: env.TDX_CLIENT_ID }, { TDX_CLIENT_SECRET: env.TDX_CLIENT_SECRET }])('keeps tools registered and returns key instructions for missing env %j', async missing => {
  const http = vi.fn(fixtureHttp), log = vi.fn();
  const client = await setup({ env: missing, railHttp: http, log });
  expect((await client.listTools()).tools).toHaveLength(3);
  for (const [name, input] of [['thsr_timetable', args], ['tra_timetable', args], ['tra_live', { train_no: '123' }]] as const) {
    const r = await call(client, name, input);
    expect(r.isError).toBe(true);
    for (const part of ['TDX 會員 API 金鑰', 'https://tdx.transportdata.tw/register', '審核後', '會員中心 → API金鑰', 'TDX_CLIENT_ID', 'TDX_CLIENT_SECRET', '重新啟動', '--toolsets rail']) expect(r.text).toContain(part);
  }
  expect(http).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
});
it('enforces the station input length through MCP', async () => {
  const client = await setup();
  const rejected = await call(client, 'thsr_timetable', { ...args, origin: 'x'.repeat(51) });
  expect(rejected.isError).toBe(true);
  const accepted = await call(client, 'thsr_timetable', { ...args, origin: 'x'.repeat(50) });
  expect(accepted.isError).toBe(true); expect(accepted.text).toContain('找不到車站');
});
it.each(['THSR', 'TRA'] as const)('skips malformed %s timetable rows before filtering', async railway => {
  const http: RailHttp = async (url, init) => {
    if (!url.includes('/OD/')) return fixtureHttp(url, init);
    const data = railFixture(railway === 'THSR' ? 'thsr-od' : 'tra-od');
    const valid = railway === 'THSR' ? data[0] : data.TrainTimetables[0];
    const missing = structuredClone(valid), badNo = structuredClone(valid), badTime = structuredClone(valid), mismatch = structuredClone(valid);
    if (railway === 'THSR') {
      delete missing.OriginStopTime; badNo.DailyTrainInfo.TrainNo = 'abc'; badTime.OriginStopTime.DepartureTime = 'bad'; mismatch.DestinationStopTime.StationID = 'wrong';
    } else {
      delete missing.StopTimes; badNo.TrainInfo.TrainNo = 'abc'; badTime.StopTimes[0].DepartureTime = 'bad'; mismatch.StopTimes[1].StationID = 'wrong';
    }
    const rows = [valid, missing, badNo, badTime, mismatch];
    return response(railway === 'THSR' ? rows : { ...data, TrainTimetables: rows });
  };
  const client = await setup({ railHttp: http });
  const tool = railway === 'THSR' ? 'thsr_timetable' : 'tra_timetable';
  const result = await call(client, tool, args);
  expect(result.isError).not.toBe(true); expect(result.text).toMatch(/\d+ 次/);
  expect(result.text.split('部分班次資料不完整')).toHaveLength(2);
  const filtered = await call(client, tool, { ...args, time: '29:59' });
  expect(filtered.text).toContain('此時段後沒有可顯示的完整班次資料'); expect(filtered.text).not.toContain('當天此時段後沒有班次'); expect(filtered.text).toContain('部分班次資料不完整');
  const allBad: RailHttp = async (url, init) => {
    if (!url.includes('/OD/')) return fixtureHttp(url, init);
    return response(railway === 'THSR' ? [{}] : { TrainTimetables: [{}] });
  };
  const empty = await call(await setup({ railHttp: allBad }), tool, args);
  expect(empty.isError).not.toBe(true); expect(empty.text).toContain('此時段後沒有可顯示的完整班次資料'); expect(empty.text).not.toContain('當天此時段後沒有班次'); expect(empty.text).toContain('部分班次資料不完整');
});
it.each(['train', 'station'] as const)('skips malformed live %s rows, including when all are invalid', async mode => {
  for (const allBad of [false, true]) {
    const http: RailHttp = async (url, init) => {
      if (!url.includes(mode === 'train' ? 'TrainLiveBoard' : 'StationLiveBoard')) return fixtureHttp(url, init);
      const data = railFixture(mode === 'train' ? 'tra-train-live' : 'tra-station-live');
      const key = mode === 'train' ? 'TrainLiveBoards' : 'StationLiveBoards';
      data[key] = [...(allBad ? [] : data[key]), { TrainNo: 'abc' }];
      return response(data);
    };
    const result = await call(await setup({ railHttp: http }), 'tra_live', mode === 'train' ? { train_no: '8121' } : { station: '臺北' });
    expect(result.isError).not.toBe(true); expect(result.text.split('部分班次資料不完整')).toHaveLength(2);
    if (allBad) {
      expect(result.text).toContain(mode === 'train' ? '查無可顯示的完整即時資料' : '臺北｜查無可顯示的完整即時資料');
      expect(result.text).not.toContain(mode === 'train' ? '查無此車次即時資料' : '查無車站即時資料');
    } else expect(result.text).toContain('次｜');
  }
});
it('formats THSR OD, sorts departures and numeric train-number ties, appends attribution', async () => {
  const r = await call(await setup(), 'thsr_timetable', args);
  expect(r.isError).not.toBe(true);
  const numbers = [...r.text.matchAll(/^(\d+) 次/gm)].map(m => m[1]);
  expect(numbers).toEqual(['0601', '0801', '0803', '0997', '0999', '0998']);
  expect(r.text).toContain('23:10 → 01:10（隔日）｜2 小時 0 分');
  expect(r.text).toContain('00:40（隔日） → 02:30（隔日）｜1 小時 50 分');
  expect(r.text).toContain('高鐵高雄站為左營站');
  expect(r.text.endsWith(attribution)).toBe(true);
});
it('formats TRA v3 OD train types, suspended/partial services, extras, and midnight durations', async () => {
  const r = await call(await setup(), 'tra_timetable', args);
  expect(r.text).toContain('自強'); expect(r.text).toContain('115 次｜自強｜10:00 → 14:30｜4 小時 30 分｜停駛');
  expect(r.text).toContain('部分停駛'); expect(r.text).toContain('加班車');
  expect(r.text).toContain('21:30 → 02:15（隔日）｜4 小時 45 分');
  expect(r.text.indexOf('123 次')).toBeLessThan(r.text.indexOf('125 次'));
  expect(r.text).toContain('00:45（隔日） → 05:15（隔日）｜4 小時 30 分');
  expect(r.text.endsWith(attribution)).toBe(true);
});
it.each(['台北', '臺北', '北車', 'Taipei', 'tAiPeI', 'Ｔａｉｐｅｉ', ' 台北車站 ', '１０００'])('resolves station aliases and normalization: %s', async origin => {
  const r = await call(await setup(), 'thsr_timetable', { ...args, origin, destination: 'Zuoying' });
  expect(r.isError).not.toBe(true); expect(r.text).toContain('臺北 → 左營');
});
it('provides up to five substring station suggestions and rejects same stations', async () => {
  const client = await setup();
  const r = await call(client, 'tra_timetable', { ...args, origin: '臺' });
  expect(r.isError).toBe(true); expect(r.text).toContain('找不到車站「臺」'); expect(r.text).toContain('臺北、臺中、臺南、臺東');
  const same = await call(client, 'thsr_timetable', { ...args, origin: '北車', destination: '臺北' });
  expect(same.isError).toBe(true); expect(same.text).toBe('起站與迄站不可相同');
});
it.each([
  [undefined, '2026-10-28'], ['今天', '2026-10-28'], ['明天', '2026-10-29'], ['後天', '2026-10-30'],
  ['2026-10-28', '2026-10-28'], ['2026/10/28', '2026-10-28'], ['民國 115-10-28', '2026-10-28'], ['115/10/28', '2026-10-28'],
])('normalizes date %s with Taipei today instead of UTC', async (date, expected) => {
  const http = vi.fn(fixtureHttp);
  const r = await call(await setup({ railHttp: http }), 'tra_timetable', { origin: '臺北', destination: '高雄', ...(date === undefined ? {} : { date }) });
  expect(r.isError).not.toBe(true); expect(r.text).toContain(`營運日 ${expected}`);
  expect(r.text).toContain(expected === '2026-10-28' ? '00:30 起' : '00:00 起');
  expect(http.mock.calls.some(([url]) => url.includes(`/to/4400/${expected}?$format=JSON`))).toBe(true);
  expect(http.mock.calls.filter(([url]) => !url.endsWith('/token')).every(([url]) => url.includes(`$top=${railRowLimit}`))).toBe(true);
});
it.each(['2026-02-29', '2026/13/01', '115/02/30', 'tomorrow', '', '2026-1-01', '民國 2026-10-28'])('rejects invalid date %s before fetching', async date => {
  const http = vi.fn(fixtureHttp);
  const r = await call(await setup({ railHttp: http }), 'tra_timetable', { ...args, date });
  expect(r.isError).toBe(true); expect(r.text).toContain('日期格式不正確'); expect(http).not.toHaveBeenCalled();
});
it.each(['30:00', '99:00', '9:00', '09:60', '24:60', '12:00:00', ''])('rejects invalid time %s', async time => {
  const http = vi.fn(fixtureHttp);
  const r = await call(await setup({ railHttp: http }), 'tra_timetable', { ...args, time });
  expect(r.isError).toBe(true); expect(r.text).toContain('時間格式不正確'); expect(r.text).toContain('00:00～29:59'); expect(http).not.toHaveBeenCalled();
});
it('filters at-or-after inclusively and retains next-day departures after evening trains', async () => {
  const client = await setup();
  const r = await call(client, 'thsr_timetable', { ...args, time: '22:00' });
  expect([...r.text.matchAll(/^(\d+) 次/gm)].map(m => m[1])).toEqual(['0997', '0999', '0998']);
});
it('uses Taipei now only for today, reports empty time windows', async () => {
  const client = await setup({ clock: () => new Date('2026-10-28T01:00:00Z') });
  const r = await call(client, 'thsr_timetable', { origin: '臺北', destination: '左營' });
  expect(r.text).not.toContain('0601 次'); expect(r.text).toContain('0801 次');
  const empty = await call(await setup({ railHttp: async (url, init) => url.includes('/OD/') ? response([]) : fixtureHttp(url, init) }), 'thsr_timetable', args);
  expect(empty.text).toContain('當天此時段後沒有班次'); expect(empty.text).not.toContain('部分班次資料不完整'); expect(empty.text.endsWith(attribution)).toBe(true);
});
it('limits to ten departures and reports the remainder', async () => {
  const http: RailHttp = async (url, init) => {
    if (!url.includes('/OD/')) return fixtureHttp(url, init);
    return response(Array.from({ length: 13 }, (_, i) => { const row = railFixture('thsr-od')[2]; row.DailyTrainInfo.TrainNo = String(600 + i); return row; }));
  };
  const r = await call(await setup({ railHttp: http }), 'thsr_timetable', args);
  expect([...r.text.matchAll(/^\d+ 次/gm)]).toHaveLength(10); expect(r.text).toContain('另有 3 班');
});
it.each(['24:00', '24:40', '29:59'])('accepts operating-day next-morning time %s', async time => {
  const r = await call(await setup(), 'thsr_timetable', { ...args, time });
  expect(r.isError).not.toBe(true); expect(r.text).toContain(`${time} 起`);
  if (time === '29:59') expect(r.text).toContain('當天此時段後沒有班次');
  else expect([...r.text.matchAll(/^(\d+) 次/gm)].map(m => m[1])).toEqual(['0998']);
});
it('suggests a usable 24+ time to reach the remaining next-day departures', async () => {
  const http: RailHttp = async (url, init) => {
    if (!url.includes('/OD/')) return fixtureHttp(url, init);
    return response(Array.from({ length: 13 }, (_, i) => {
      const row = railFixture('thsr-od')[0];
      row.DailyTrainInfo.TrainNo = String(600 + i);
      row.DailyTrainInfo.Overnight = true;
      row.OriginStopTime.DepartureTime = `00:${String(i * 4).padStart(2, '0')}:00`;
      row.DestinationStopTime.ArrivalTime = `02:${String(i * 4).padStart(2, '0')}:00`;
      return row;
    }).reverse());
  };
  const client = await setup({ railHttp: http });
  const first = await call(client, 'thsr_timetable', { ...args, time: '24:00' });
  expect([...first.text.matchAll(/^(\d+) 次/gm)].map(m => m[1])).toEqual(Array.from({ length: 10 }, (_, i) => String(600 + i)));
  expect(first.text).toContain('另有 3 班');
  const suggested = /另有 3 班，請指定 time=(\d{2}:\d{2}) 查詢/.exec(first.text)?.[1];
  expect(suggested).toBe('24:40');
  const next = await call(client, 'thsr_timetable', { ...args, time: suggested! });
  expect([...next.text.matchAll(/^(\d+) 次/gm)].map(m => m[1])).toEqual(['610', '611', '612']);
  expect(next.text).not.toContain('另有');
});
it('sends an explicit row cap on all six data endpoints', async () => {
  const http = vi.fn(fixtureHttp), s = service(http);
  await s.timetable('THSR', args); await s.timetable('TRA', args);
  await s.live({ train_no: '8121' }); await s.live({ station: '臺北' });
  const urls = http.mock.calls.map(([url]) => url).filter(url => !url.endsWith('/token'));
  expect(urls).toHaveLength(6);
  for (const url of urls) {
    expect(url).toContain(`$top=${railRowLimit}`);
    expect(new URL(url).searchParams.get('$top')).toBe(String(railRowLimit));
    expect(new URL(url).searchParams.has('$skip')).toBe(false);
  }
});
it.each([
  ['thsr-stations', '/THSR/Station?', undefined], ['tra-stations', '/TRA/Station?', 'Stations'],
  ['thsr-od', '/THSR/DailyTimetable/OD/', undefined], ['tra-od', '/TRA/DailyTrainTimetable/OD/', 'TrainTimetables'],
  ['tra-train-live', '/TRA/TrainLiveBoard/', 'TrainLiveBoards'], ['tra-station-live', '/TRA/StationLiveBoard/', 'StationLiveBoards'],
] as const)('warns when %s reaches the cap, including cached stations and filtered timetables', async (file, path, field) => {
  const http: RailHttp = async (url, init) => {
    if (!url.includes(path)) return fixtureHttp(url, init);
    const data = railFixture(file), source = field ? data[field] : data;
    const rows = Array.from({ length: railRowLimit }, (_, i) => source[i % source.length]);
    return response(field ? { ...data, [field]: rows } : rows);
  };
  const client = await setup({ railHttp: http });
  for (let i = 0; i < 2; i++) {
    const r = file.endsWith('live')
      ? await call(client, 'tra_live', file === 'tra-train-live' ? { train_no: '8121' } : { station: '臺北' })
      : await call(client, file.startsWith('thsr') ? 'thsr_timetable' : 'tra_timetable', { ...args, time: '29:59' });
    expect(r.isError).not.toBe(true);
    expect(r.text.split(truncatedNote)).toHaveLength(2);
    expect(r.text.endsWith(attribution)).toBe(true);
  }
});
it('warns about a capped station list on missing stations and an empty station board', async () => {
  const http: RailHttp = async (url, init) => {
    if (url.includes('/TRA/Station?')) {
      const data = railFixture('tra-stations');
      data.Stations = Array.from({ length: railRowLimit }, (_, i) => data.Stations[i % data.Stations.length]);
      return response(data);
    }
    return url.includes('StationLiveBoard') ? response({ StationLiveBoards: [] }) : fixtureHttp(url, init);
  };
  const client = await setup({ railHttp: http });
  const missing = await call(client, 'tra_live', { station: '不存在' });
  expect(missing.isError).toBe(true); expect(missing.text).toContain(truncatedNote);
  const empty = await call(client, 'tra_live', { station: '臺北' });
  expect(empty.isError).not.toBe(true); expect(empty.text).toContain('查無車站即時資料'); expect(empty.text).toContain(truncatedNote);
});
it('caches station lists for 24h and deduplicates concurrent station and token requests', async () => {
  let now = clock().getTime();
  const http = vi.fn(fixtureHttp), s = createRailService({ credentials, http, clock: () => new Date(now) });
  await Promise.all(Array.from({ length: 5 }, () => s.timetable('THSR', args)));
  expect(http.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
  expect(http.mock.calls.filter(([url]) => url.includes('/THSR/Station?'))).toHaveLength(1);
  now += 86400_000;
  await s.timetable('THSR', args);
  expect(http.mock.calls.filter(([url]) => url.includes('/THSR/Station?'))).toHaveLength(2);
});
it('shares token across tools, refreshes before expiry and uses encoded client-credentials POST', async () => {
  let now = clock().getTime();
  const http = vi.fn<RailHttp>(async (url, init) => url.endsWith('/token') ? response({ access_token: 'cached-token', expires_in: 120, token_type: 'Bearer' }) : fixtureHttp(url, init));
  const s = createRailService({ credentials: { clientId: 'id &+=', clientSecret: 'secret &+=' }, http, clock: () => new Date(now) });
  await s.timetable('THSR', args); await s.timetable('TRA', args); await s.live({ train_no: '123' });
  expect(http.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
  const init = http.mock.calls[0][1];
  expect(init.method).toBe('POST'); expect(init.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({ grant_type: 'client_credentials', client_id: 'id &+=', client_secret: 'secret &+=' });
  expect(http.mock.calls.find(([url]) => url.includes('/api/basic/'))?.[1].headers?.authorization).toBe('Bearer cached-token');
  now += 120_000;
  await s.live({ train_no: '123' });
  expect(http.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
  expect(http.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it('defaults token lifetime to 86400 seconds', async () => {
  let now = 0;
  const http = vi.fn<RailHttp>(async url => url.endsWith('/token') ? response({ access_token: 'default-expiry' }) : response({ ok: true }));
  const c = createTdxClient(credentials, http, () => new Date(now));
  await c.get('/test'); now = 86300_000; await c.get('/test');
  expect(http.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
  now = 86341_000; await c.get('/test');
  expect(http.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
});
it('invalidates a rejected API token and retries exactly once, sharing refresh across concurrent 401s', async () => {
  let tokens = 0;
  const http = vi.fn<RailHttp>(async (url, init) => {
    if (url.endsWith('/token')) return response({ access_token: `token-${++tokens}` });
    if (init.headers?.authorization === 'Bearer token-1') return response({ private: 'ignored' }, 401);
    return response({ value: true });
  });
  const c = createTdxClient(credentials, http, clock);
  expect(await Promise.all([c.get('/test'), c.get('/test'), c.get('/test')])).toEqual([{ value: true }, { value: true }, { value: true }]);
  expect(tokens).toBe(2);
  const denied = vi.fn<RailHttp>(async url => url.endsWith('/token') ? response({ access_token: 'retry-token' }) : response({}, 401));
  const r = await service(denied).live({ train_no: '123' });
  expect(r).toEqual({ text: unavailable, isError: true });
  expect(denied.mock.calls.filter(([url]) => !url.endsWith('/token'))).toHaveLength(2);
});
it.each(['token-reject', 'token-503', 'api-503', 'throw', 'json', 'malformed-token', 'malformed-api'] as const)('redacts credentials, tokens, upstream bodies and errors: %s', async mode => {
  const privateText = [env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET, 'synthetic-access-token', 'upstream-private-body'].join(' ');
  const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  const log = vi.fn();
  const http: RailHttp = async (url, init) => {
    if (mode === 'throw') throw new Error(privateText);
    if (mode === 'json') return { status: 200, json: async () => { throw new Error(privateText); } };
    if (url.endsWith('/token')) {
      if (mode === 'token-reject' || mode === 'token-503') return response({ message: privateText }, mode === 'token-reject' ? 401 : 503);
      if (mode === 'malformed-token') return response({ access_token: '', expires_in: -1 });
    } else {
      if (mode === 'api-503') return response({ message: privateText }, 503);
      if (mode === 'malformed-api') return response({ message: privateText });
    }
    return fixtureHttp(url, init);
  };
  const r = await call(await setup({ railHttp: http, log }), 'tra_live', { train_no: '123' });
  expect(r.isError).toBe(true); expect(r.text).toBe(mode === 'token-reject' ? rejected : unavailable);
  for (const secret of privateText.split(' ')) expect(r.text).not.toContain(secret);
  expect(log).not.toHaveBeenCalled(); for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
it.each([['8121', '晚 5 分', '已離站', '臺中', '14:00'], ['101', '準點', '在站上', '臺北', '06:00']])('formats live train %s', async (train_no, delay, status, station, time) => {
  const r = await call(await setup(), 'tra_live', { train_no });
  expect(r.text).toContain(delay); expect(r.text).toContain(`目前位置：${station}（${status}）`);
  expect(r.text).toContain(`2026-10-28 ${time}（臺北時間）`); expect(r.text.endsWith(attribution)).toBe(true);
});
it('formats train approaching station and handles unknown update timestamp safely', async () => {
  const http: RailHttp = async () => { const data = railFixture('tra-train-live'); data.TrainLiveBoards[0].TrainStationStatus = 0; data.TrainLiveBoards[0].UpdateTime = 'string'; return response(data); };
  // Use a real token fixture then the modified API response.
  const r = await service((url, init) => url.endsWith('/token') ? fixtureHttp(url, init) : http(url, init)).live({ train_no: '8121' });
  expect(r.text).toContain('進站中'); expect(r.text).toContain('更新時間未提供');
});
it('formats station board delays, cancellation, scheduled times and platforms', async () => {
  const r = await call(await setup(), 'tra_live', { station: '台北車站' });
  for (const part of ['準點', '晚 5 分', '取消', '月台 1', '101 次', '表訂到站 06:00／離站 06:00', '8121 次', '表訂到站 12:00／離站 12:00', '115 次', '表訂到站 10:00／離站 10:00', '往 高雄']) expect(r.text).toContain(part);
  expect(r.text.endsWith(attribution)).toBe(true);
});
it('handles empty live train and station results with attribution', async () => {
  const r = await call(await setup(), 'tra_live', { train_no: '99999' });
  expect(r.isError).not.toBe(true); expect(r.text).toContain('查無此車次即時資料（可能尚未發車或已抵達）'); expect(r.text).not.toContain('部分班次資料不完整'); expect(r.text.endsWith(attribution)).toBe(true);
  const empty = await service((url, init) => url.includes('StationLiveBoard') ? Promise.resolve(response({ StationLiveBoards: [] })) : fixtureHttp(url, init)).live({ station: '臺北' });
  expect(empty.text).toContain('查無車站即時資料'); expect(empty.text).not.toContain('部分班次資料不完整'); expect(empty.text.endsWith(attribution)).toBe(true);
});
it.each([{}, { train_no: '123', station: '臺北' }, { train_no: '123/../../' }, { station: '' }])('rejects invalid live arguments %j', async input => {
  const r = await call(await setup(), 'tra_live', input); expect(r.isError).toBe(true);
});
it.each(['thsr-stations', 'thsr-od', 'tra-stations', 'tra-od', 'tra-train-live', 'tra-station-live', 'token'])('handles doc-example %s without crashing or placeholder leakage', async file => {
  const http: RailHttp = async (url, init) => {
    const match = file === 'token' ? url.endsWith('/token') : file.endsWith('stations') ? url.includes(file.startsWith('thsr') ? '/THSR/Station?' : '/TRA/Station?') : file.endsWith('od') ? url.includes('/OD/') : url.includes(file === 'tra-train-live' ? 'TrainLiveBoard' : 'StationLiveBoard');
    return match ? response(railFixture(file, 'doc-examples')) : fixtureHttp(url, init);
  };
  const client = await setup({ railHttp: http });
  const r = file.includes('live') || file === 'token' ? await call(client, 'tra_live', file === 'tra-station-live' ? { station: '臺北' } : { train_no: '123' }) : await call(client, file.startsWith('thsr') ? 'thsr_timetable' : 'tra_timetable', args);
  if (file === 'token') expect(r.isError).not.toBe(true);
  else if (file.endsWith('stations')) { expect(r.isError).toBe(true); expect(r.text).toContain('找不到車站'); }
  else { expect(r.isError).not.toBe(true); expect(r.text).toContain('部分班次資料不完整'); }
});
it('keeps synthetic fields and types faithful to the doc example shapes', () => {
  function shape(actual: any, example: any) {
    if (Array.isArray(example)) { expect(Array.isArray(actual)).toBe(true); for (const item of actual) shape(item, example[0]); }
    else if (example !== null && typeof example === 'object') {
      expect(typeof actual).toBe('object');
      for (const [key, value] of Object.entries(actual)) { expect(example).toHaveProperty(key); shape(value, example[key]); }
    } else expect(typeof actual).toBe(typeof example);
  }
  for (const file of ['thsr-stations', 'thsr-od', 'tra-stations', 'tra-od', 'tra-train-live', 'tra-station-live', 'token']) shape(railFixture(file), railFixture(file, 'doc-examples'));
});
it('handles cross-day markers even without clock wrap and exposes inference', () => {
  expect(operatingTimes(23 * 60, 23 * 60 + 30, true, undefined)).toEqual({ departure: 1380, arrival: 1410, inferred: false });
  expect(operatingTimes(23 * 60, 60, false, undefined)).toEqual({ departure: 1380, arrival: 1500, inferred: false });
  expect(operatingTimes(30, 60, true, 'destination')).toEqual({ departure: 1470, arrival: 1500, inferred: true });
  expect(operatingTimes(1435, 1439, true, 'origin')).toEqual({ departure: 1435, arrival: 1439, inferred: false });
  expect(operatingTimes(1435, 30, true, 'destination')).toEqual({ departure: 1435, arrival: 1470, inferred: false });
  expect(operatingTimes(45, 315, true, 'origin')).toEqual({ departure: 1485, arrival: 1755, inferred: true });
  expect(operatingTimes(719, 720, true, undefined)).toEqual({ departure: 2159, arrival: 2160, inferred: true });
  expect(operatingTimes(720, 780, true, undefined)).toEqual({ departure: 720, arrival: 780, inferred: false });
  expect(operatingTimes(60, 30, true, undefined)).toEqual({ departure: 1500, arrival: 2910, inferred: true });
});
it.each(['THSR', 'TRA'] as const)('keeps an evening %s segment on the operating day despite overnight signals', async railway => {
  const http: RailHttp = async (url, init) => {
    if (!url.includes('/OD/')) return fixtureHttp(url, init);
    if (railway === 'THSR') {
      const row = railFixture('thsr-od')[0];
      row.DailyTrainInfo.Overnight = true;
      row.OriginStopTime.DepartureTime = '21:00:00'; row.DestinationStopTime.ArrivalTime = '22:00:00';
      return response([row]);
    }
    const data = railFixture('tra-od'), row = data.TrainTimetables[0];
    row.TrainInfo.OverNightStationID = '1000';
    row.StopTimes[0].DepartureTime = '23:55:00'; row.StopTimes[1].ArrivalTime = '23:59:00';
    data.TrainTimetables = [row];
    return response(data);
  };
  const r = await call(await setup({ railHttp: http }), railway === 'THSR' ? 'thsr_timetable' : 'tra_timetable', args);
  expect(r.isError).not.toBe(true);
  expect(r.text).toContain(railway === 'THSR' ? '21:00 → 22:00｜1 小時 0 分' : '23:55 → 23:59｜4 分');
  expect(r.text).not.toContain('隔日'); expect(r.text).not.toContain('跨夜日序依時刻推定');
});

const railQuestions = JSON.parse(readFileSync(new URL('../evals/taiwan-questions.json', import.meta.url), 'utf8')).filter((q: { toolset: string }) => q.toolset === 'rail');
it.each(railQuestions)('answers synthetic eval $id with fixture-checkable facts', async q => {
  const r = await call(await setup(), q.expected_tool, q.expected_args);
  expect(r.isError).not.toBe(true);
  for (const fact of q.expected_key_facts) expect(r.text).toContain(fact);
  expect(q.notes).toContain('以 test/fixtures/tdx/synthetic 測試資料為準（非即時資料）');
});
