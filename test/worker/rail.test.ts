import { env, createExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { buildInvoiceSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import xml from '../fixtures/invoice.xml?raw';
import worker, { keys, type Env } from '../../src/worker/index.js';
import { compactStations, compactTimetable, stationKey, timetableKey } from '../../src/core/rail/snapshot.js';
import { truncatedNote } from '../../src/core/rail/client.js';
import { userCredentials } from '../../src/worker/rail.js';
import thsrStations from '../fixtures/tdx/real/thsr-stations.json';
import traStations from '../fixtures/tdx/real/tra-stations.json';
import thsrOD from '../fixtures/tdx/real/thsr-od-1000-1070.json';
import traOD from '../fixtures/tdx/real/tra-od-1000-4400.json';
import liveTrain from '../fixtures/tdx/real/tra-train-live-2037.json';
import liveStation from '../fixtures/tdx/real/tra-station-live-1000.json';
const bindings = env as unknown as Env;
const credentials = { TDX_CLIENT_ID: 'project-id-SENTINEL', TDX_CLIENT_SECRET: 'project-secret-SENTINEL' };
const date = '2026-10-29', fetchedAt = '2026-10-28T16:23:00.000Z';
// Synthetic TrainDate response derived from captured OD fixtures (not a new capture).
const thsrDaily = thsrOD.map(row => ({ DailyTrainInfo: row.DailyTrainInfo, StopTimes: [row.OriginStopTime, row.DestinationStopTime] }));
const seed = async () => {
  for (const railway of ['THSR', 'TRA'] as const) {
    await bindings.SNAPSHOTS.put(stationKey(railway), JSON.stringify(compactStations(railway, railway === 'THSR' ? thsrStations : traStations, fetchedAt)));
    for (const day of [date, '2026-10-30']) await bindings.SNAPSHOTS.put(timetableKey(railway, day), JSON.stringify(compactTimetable(railway, railway === 'THSR' ? thsrDaily : traOD, day, fetchedAt)));
  }
};
let sequence = 0;
const nextIp = () => `172.16.${sequence >> 8 & 255}.${sequence++ & 255}`;
async function rpc(name: string, args: object, options: { env?: Env; headers?: Record<string, string>; ip?: string } = {}) {
  const response = await worker.fetch(new Request('http://localhost/mcp', {
    method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': options.ip ?? nextIp(), ...options.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), options.env ?? bindings, createExecutionContext());
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, result: undefined, text };
  const parsed = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text);
  return { status: response.status, result: parsed.result, text };
}
const textOf = (response: Awaited<ReturnType<typeof rpc>>) => {
  expect(response.status).toBe(200);
  expect(response.result.isError).not.toBe(true);
  const text: string = response.result.content[0].text;
  expect(text).toContain('資料介接「交通部TDX平臺」');
  expect(text).not.toMatch(/\{|undefined|NaN|\[object/);
  return text;
};
beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP must be mocked'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T10:18:00Z'));
  const listed = await bindings.SNAPSHOTS.list();
  await Promise.all(listed.keys.map(({ name }) => bindings.SNAPSHOTS.delete(name)));
});
afterEach(() => {
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  vi.useRealTimers(); vi.restoreAllMocks();
});
it.each([
  ['thsr_timetable', { origin: '臺北', destination: '高雄' }, '0673 次｜高鐵'],
  ['tra_timetable', { origin: '臺北', destination: '高雄' }, '149 次'],
] as const)('serves %s entirely from snapshots with the Taipei update time', async (name, args, expected) => {
  await seed();
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('request timetable must not fetch'));
  const text = textOf(await rpc(name, args));
  expect(text).toContain(expected); expect(text).toContain('時刻表資料：2026-10-29 00:23（臺北時間）更新');
  expect(http).not.toHaveBeenCalled();
});
it('preserves snapshot timetable validation errors with truncation, update time and attribution', async () => {
  await seed();
  await bindings.SNAPSHOTS.put(timetableKey('TRA', date), JSON.stringify(compactTimetable('TRA', traOD, date, fetchedAt, true)));
  for (const [args, message] of [
    [{ origin: '臺北', destination: '高雄', time: '30:00' }, '時間格式不正確'],
    [{ origin: '不存在', destination: '高雄' }, '找不到車站'],
    [{ origin: '臺北', destination: '臺北' }, '起站與迄站不可相同'],
  ] as const) {
    const response = await rpc('tra_timetable', args);
    expect(response.status).toBe(200); expect(response.result.isError).toBe(true);
    const text = response.result.content[0].text;
    expect(text).toContain(message); expect(text).toContain(truncatedNote);
    expect(text).toContain('時刻表資料：2026-10-29 00:23（臺北時間）更新');
    expect(text).toContain('資料介接「交通部TDX平臺」');
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('explains missing snapshots and date coverage without errors or fetching', async () => {
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const list = vi.spyOn(bindings.SNAPSHOTS, 'list');
  const args = { origin: '臺北', destination: '高雄', date: '後天' };
  expect(textOf(await rpc('tra_timetable', args))).toContain('只涵蓋今天與明天');
  expect(textOf(await rpc('tra_timetable', { ...args, date: '今天' }))).toContain('時刻表資料尚未準備好');
  await seed();
  expect(textOf(await rpc('tra_timetable', args))).toContain('公開網址的時刻表只涵蓋今天與明天（臺北時間）');
  // Old KV keys survive for three days but are outside the public date window.
  await bindings.SNAPSHOTS.put(timetableKey('TRA', '2026-10-28'), JSON.stringify(compactTimetable('TRA', traOD, '2026-10-28', fetchedAt)));
  expect(textOf(await rpc('tra_timetable', { ...args, date: '2026-10-28' }))).toContain('只涵蓋今天與明天');
  expect(http).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
it.each([date, '2026-10-30'])('reports a missing covered snapshot for %s even when other timetables exist', async day => {
  await seed();
  await bindings.SNAPSHOTS.delete(timetableKey('TRA', day));
  const list = vi.spyOn(bindings.SNAPSHOTS, 'list');
  const text = textOf(await rpc('tra_timetable', { origin: '臺北', destination: '高雄', date: day }));
  expect(text).toContain('時刻表資料尚未準備好'); expect(text).not.toContain('只涵蓋今天與明天');
  expect(list).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it.each([{ train_no: '999' }, { station: '高雄' }])('reads yesterday for overnight fallback %j', async args => {
  await seed();
  vi.setSystemTime(new Date('2026-10-29T00:05:00+08:00'));
  const previous = compactTimetable('TRA', traOD, '2026-10-28', '2026-10-27T16:23:00Z');
  previous.trains = [{ ...previous.trains[0], no: '999', overnight: true, stops: [['1000', '23:00', '23:01', 0], ['4400', '00:20', '00:21', 0]] }];
  await bindings.SNAPSHOTS.put(timetableKey('TRA', previous.date), JSON.stringify(previous));
  const text = textOf(await rpc('tra_live', args));
  expect(text).toContain('999 次'); expect(text).toContain('00:21');
  expect(fetch).not.toHaveBeenCalled();
});
it.each([{ train_no: '149' }, { station: '臺北' }])('degrades tra_live without a project key for %j', async args => {
  await seed();
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const text = textOf(await rpc('tra_live', args));
  expect(text).toContain('伺服器尚未設定 TDX 金鑰'); expect(text).toContain('即時誤點暫時無法提供，可帶自己的 TDX 金鑰查即時資料');
  expect(text).toContain('表訂時間'); expect(text).toContain('時刻表資料：2026-10-29 00:23（臺北時間）更新');
  expect(http).not.toHaveBeenCalled();
});
it('degrades tra_live without either project key or snapshots', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const text = textOf(await rpc('tra_live', { train_no: '149' }));
  expect(text).toContain('伺服器尚未設定 TDX 金鑰'); expect(text).toContain('時刻表資料尚未準備好');
});
it.each(['minute', 'daily', 'monthly', 'ip', 'auth', 'upstream', 'nokey'])('renders a non-error scheduled fallback on gateway %s', async reason => {
  await seed();
  const fake = { idFromName: vi.fn(() => 'tdx'), get: vi.fn(() => ({ live: vi.fn(async () => ({ ok: false, reason })) })) };
  const text = textOf(await rpc('tra_live', { train_no: '149' }, { env: { ...bindings, ...credentials, TDX_GATEWAY: fake as unknown as Env['TDX_GATEWAY'] } }));
  expect(text).toContain('149 次'); expect(text).toContain('即時誤點暫時無法提供');
  expect(fake.idFromName).toHaveBeenCalledWith('tdx');
});
it.each([{ train_no: '2037' }, { station: '臺北' }])('renders successful gateway live data for %j with data age', async args => {
  await seed();
  const live = vi.fn(async () => ({ ok: true, data: args.train_no ? liveTrain : liveStation, fetchedAt: '2026-10-29T10:16:00.000Z' }));
  const fake = { idFromName: vi.fn(() => 'tdx'), get: () => ({ live }) };
  const text = textOf(await rpc('tra_live', args, { env: { ...bindings, ...credentials, TDX_GATEWAY: fake as unknown as Env['TDX_GATEWAY'] }, ip: '192.0.2.81' }));
  expect(text).toContain('晚 2 分'); expect(text).toContain('即時資料約 2 分鐘前取得');
  expect(live.mock.calls[0]).toEqual([args.train_no ? '/v3/Rail/TRA/TrainLiveBoard/TrainNo/2037' : '/v3/Rail/TRA/StationLiveBoard/Station/1000', '192.0.2.81']);
});
it.each([
  { 'X-TDX-Client-Id': 'one-only' }, { 'X-TDX-Client-Secret': 'one-only' },
  { 'X-TDX-Client-Id': 'x'.repeat(257), 'X-TDX-Client-Secret': 'test' },
  { 'X-TDX-Client-Id': 'non-ascii-\u00e9', 'X-TDX-Client-Secret': 'test' },
])('hints invalid user credentials without fetching: %j', async headers => {
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  expect(textOf(await rpc('tra_live', { train_no: '2037' }, { headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }))).toContain('請同時提供有效的 X-TDX-Client-Id');
  expect(http).not.toHaveBeenCalled();
});
it('strips both headers before transport and trims sentinel credentials', () => {
  const headers = new Headers({ 'X-TDX-Client-Id': ' test-id ', 'X-TDX-Client-Secret': ' test-secret ' });
  expect(userCredentials(headers)).toEqual({ clientId: 'test-id', clientSecret: 'test-secret' });
  expect([...headers]).toEqual([]);
  const control = new Headers({ 'X-TDX-Client-Id': 'test\tbad', 'X-TDX-Client-Secret': 'test' });
  expect(userCredentials(control)).toBe('invalid'); expect([...control]).toEqual([]);
});
it.each(['token', 'live'])('maps a user-key %s redirect to the existing unavailable error without following it', async endpoint => {
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => endpoint === 'live' && String(input).endsWith('/token')
    ? Response.json({ access_token: 'user-token-SENTINEL', expires_in: 3600 })
    : new Response(null, { status: 302, headers: { location: 'https://other.example/redirect' } }));
  const response = await rpc('tra_live', { train_no: '2037' }, { headers: { 'X-TDX-Client-Id': 'user-id', 'X-TDX-Client-Secret': 'user-secret' } });
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain('TDX 服務暫時無法使用，請稍後再試');
  expect(http).toHaveBeenCalledTimes(endpoint === 'token' ? 1 : 2);
  expect(http.mock.calls.every(([url]) => String(url).startsWith('https://tdx.transportdata.tw/'))).toBe(true);
});
it('isolates user keys, never calls the gateway or KV, and obtains a fresh token per request', async () => {
  const user = { 'X-TDX-Client-Id': 'user-id-SENTINEL-9f2c', 'X-TDX-Client-Secret': 'user-secret-SENTINEL-7a3d' };
  const sensitive = [...Object.values(user), 'user-token-SENTINEL'];
  const consoles = ['warn', 'log', 'error'].map(method => vi.spyOn(console, method as 'warn').mockImplementation(() => {}));
  const get = vi.spyOn(bindings.SNAPSHOTS, 'get'), put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  const project = bindings.TDX_GATEWAY.get(bindings.TDX_GATEWAY.idFromName('tdx'));
  const before = await project.usage();
  get.mockClear();
  const forbidden = vi.fn(() => { throw new Error('user mode must not access project gateway'); });
  const fake = { idFromName: forbidden, get: forbidden } as unknown as Env['TDX_GATEWAY'];
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    expect(sensitive.every(value => !url.includes(value))).toBe(true);
    if (url.endsWith('/token')) {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'client_credentials', client_id: user['X-TDX-Client-Id'], client_secret: user['X-TDX-Client-Secret'] });
      return Response.json({ access_token: sensitive[2], expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${sensitive[2]}`);
    if (url.includes('/THSR/Station')) return Response.json(thsrStations);
    if (url.includes('/TRA/Station?')) return Response.json(traStations);
    return Response.json(url.includes('/THSR/') ? thsrOD : url.includes('/OD/') ? traOD : liveTrain);
  });
  for (const [name, args] of [
    ['thsr_timetable', { origin: '臺北', destination: '高雄', date: '2026-10-29' }],
    ['tra_timetable', { origin: '臺北', destination: '高雄', date: '2026-10-29' }],
    ['tra_live', { train_no: '2037' }], ['tra_live', { train_no: '2037' }],
  ] as const) {
    const response = await rpc(name, args, { headers: user, env: { ...bindings, ...credentials, TDX_GATEWAY: fake } });
    textOf(response);
    for (const value of sensitive) expect(response.text).not.toContain(value);
  }
  expect(http.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(4);
  expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  expect(await project.usage()).toEqual(before);
  const listed = await bindings.SNAPSHOTS.list();
  const allKV = await Promise.all(listed.keys.map(async ({ name }) => [name, await bindings.SNAPSHOTS.get(name)]));
  for (const value of sensitive) {
    expect(JSON.stringify(allKV)).not.toContain(value); expect(JSON.stringify(await project.usage())).not.toContain(value);
    for (const spy of consoles) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);
  }
  const ip = nextIp();
  for (let i = 0; i < 30; i++) expect((await rpc('tra_live', { train_no: '2037' }, { headers: user, ip, env: { ...bindings, TDX_GATEWAY: fake } })).status).toBe(200);
  expect((await rpc('tra_live', { train_no: '2037' }, { headers: user, ip })).status).toBe(429);
});

it.each([{}, { 'X-TDX-Client-Id': 'user-id-SENTINEL', 'X-TDX-Client-Secret': 'user-secret-SENTINEL' }, { 'X-TDX-Client-Id': 'only-one-SENTINEL' }])('keeps invoice responses independent of rail credentials %j', async headers => {
  const snapshot = await buildInvoiceSnapshot(async () => xml);
  await bindings.SNAPSHOTS.put(keys.invoice, encodeSnapshot(snapshot));
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invoice must not fetch'));
  const response = await rpc('invoice_get_winning_numbers', {}, { headers: headers as Record<string, string> });
  expect(response.status).toBe(200); expect(response.result.isError).not.toBe(true);
  expect(response.result.content[0].text).toContain('統一發票中獎號碼'); expect(http).not.toHaveBeenCalled();
});
