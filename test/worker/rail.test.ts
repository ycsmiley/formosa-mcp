import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { buildInvoiceSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import xml from '../fixtures/invoice.xml?raw';
import worker, { keys, type Env } from '../../src/worker/index.js';
import { compactStations, compactTimetable, stationKey, timetableKey } from '../../src/core/rail/snapshot.js';
import { refreshRail, userCredentials } from '../../src/worker/rail.js';
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
it('explains missing snapshots and date coverage without errors or fetching', async () => {
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const args = { origin: '臺北', destination: '高雄', date: '後天' };
  expect(textOf(await rpc('tra_timetable', args))).toContain('時刻表資料尚未準備好，請稍後再試；也可帶自己的 TDX 金鑰查詢。');
  await seed();
  expect(textOf(await rpc('tra_timetable', args))).toContain('公開網址的時刻表只涵蓋今天與明天（臺北時間）');
  // Old KV keys survive for three days but are outside the public date window.
  await bindings.SNAPSHOTS.put(timetableKey('TRA', '2026-10-28'), JSON.stringify(compactTimetable('TRA', traOD, '2026-10-28', fetchedAt)));
  expect(textOf(await rpc('tra_timetable', { ...args, date: '2026-10-28' }))).toContain('只涵蓋今天與明天');
  expect(http).not.toHaveBeenCalled();
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

// The cron's RPC stub accounts each admission; HTTP bodies stay in the cron.
function cronEnv(acquire = vi.fn(async () => ({ ok: true as const, token: 'cron-token-SENTINEL' }))) {
  const usage = vi.fn(async () => ({ month: '2026-10', monthUsed: 10, monthlyQuota: 4500, liveCeiling: 4050, pct: 0.22, today: date, todayUsed: 10, dailyBudget: 100, byPurpose: { token: 1, live: 0, snapshot: 9 }, last60s: 2, updatedAt: new Date().toISOString() }));
  const namespace = { idFromName: vi.fn(() => 'tdx'), get: () => ({ acquire, usage }) };
  return { env: { ...bindings, ...credentials, TDX_GATEWAY: namespace as unknown as Env['TDX_GATEWAY'] }, acquire, usage };
}
const cronHttp = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/Station')) return Response.json(path.includes('/THSR/') ? thsrStations : traStations);
  return Response.json(path.includes('/THSR/') ? thsrDaily : traOD);
});
it('rail cron writes six compact snapshots with TTLs; steady state fetches nothing', async () => {
  const scenario = cronEnv(), http = cronHttp(), put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  await worker.scheduled(createScheduledController({ cron: '23 16,20 * * *' }), scenario.env, createExecutionContext());
  const expected = ['THSR', 'TRA'].flatMap(r => [stationKey(r as 'TRA'), timetableKey(r as 'TRA', date), timetableKey(r as 'TRA', '2026-10-30')]);
  for (const key of expected) {
    const snapshot = JSON.parse((await bindings.SNAPSHOTS.get(key))!);
    expect(snapshot).toMatchObject({ v: 1, truncated: false });
    if (key.includes(':timetable:')) expect(put.mock.calls.find(([written]) => written === key)?.[2]).toEqual({ expirationTtl: 259200 });
  }
  expect(http).toHaveBeenCalledTimes(6); expect(scenario.acquire).toHaveBeenCalledTimes(6);
  expect(await bindings.SNAPSHOTS.get('tdx:usage:v1')).not.toBeNull();
  http.mockClear(); scenario.acquire.mockClear();
  await refreshRail(scenario.env);
  expect(http).not.toHaveBeenCalled(); expect(scenario.acquire).not.toHaveBeenCalled();
  // Following day: yesterday's tomorrow exists, so only the next day's pair is fetched.
  vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
  await refreshRail(scenario.env);
  expect(http).toHaveBeenCalledTimes(2);
  expect(http.mock.calls.every(([url]) => String(url).includes('/TrainDate/2026-10-31'))).toBe(true);
});
it('skips missing project keys once, with zero HTTP or gateway calls', async () => {
  const http = cronHttp(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await refreshRail(bindings);
  expect(http).not.toHaveBeenCalled(); expect(warn).toHaveBeenCalledExactlyOnceWith('rail snapshot skipped: no project TDX key');
});
it('refetches stations only after seven days', async () => {
  await seed(); const scenario = cronEnv(), http = cronHttp();
  await refreshRail(scenario.env); expect(http).not.toHaveBeenCalled();
  const old = compactStations('TRA', traStations, '2026-10-20T00:00:00Z');
  await bindings.SNAPSHOTS.put(stationKey('TRA'), JSON.stringify(old));
  await refreshRail(scenario.env); expect(http).toHaveBeenCalledTimes(1);
  expect(String(http.mock.calls[0][0])).toContain('/TRA/Station?');
});
it.each([2, 3])('paginates TRA in pages of one thousand with cap %i', async pages => {
  await seed(); const scenario = cronEnv(), http = cronHttp();
  await bindings.SNAPSHOTS.delete(timetableKey('TRA', date));
  const train = traOD.TrainTimetables[0];
  http.mockImplementation(async input => {
    const url = new URL(String(input)), page = Number(url.searchParams.get('$skip') ?? 0) / 1000;
    return Response.json({ TrainTimetables: Array.from({ length: pages === 2 && page === 1 ? 1 : 1000 }, () => train) });
  });
  await refreshRail(scenario.env);
  expect(http).toHaveBeenCalledTimes(pages);
  expect(http.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('$skip'))).toEqual(pages === 2 ? [null, '1000'] : [null, '1000', '2000']);
  const snapshot = JSON.parse((await bindings.SNAPSHOTS.get(timetableKey('TRA', date)))!);
  expect(snapshot.trains).toHaveLength(pages === 2 ? 1001 : 3000); expect(snapshot.truncated).toBe(pages === 3);
});
it.each(['empty', 'invalid', 'upstream'])('keeps previous stations and writes no invalid %s timetable', async failure => {
  await seed(); const scenario = cronEnv(), http = cronHttp(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await bindings.SNAPSHOTS.delete(timetableKey('TRA', date));
  const before = await bindings.SNAPSHOTS.get(stationKey('TRA'));
  http.mockImplementation(async () => failure === 'upstream' ? new Response('private diagnostic', { status: 500 }) : Response.json(failure === 'empty' ? { TrainTimetables: [] } : { invalid: true }));
  await refreshRail(scenario.env);
  expect(await bindings.SNAPSHOTS.get(timetableKey('TRA', date))).toBeNull();
  expect(await bindings.SNAPSHOTS.get(stationKey('TRA'))).toBe(before);
  expect(warn).toHaveBeenCalledWith(`rail snapshot skipped: TRA ${date} unavailable`);
});
it('waits and retries minute-limited snapshot admissions, capped at three waits per step', async () => {
  await seed();
  await bindings.SNAPSHOTS.delete(timetableKey('TRA', date));
  vi.useFakeTimers();
  const scenario = cronEnv(), http = cronHttp();
  scenario.acquire.mockImplementation(async () => ({ ok: false, reason: 'minute', retryAfterMs: 1000 }) as any);
  const work = refreshRail(scenario.env);
  await vi.advanceTimersByTimeAsync(3000); await work;
  expect(scenario.acquire).toHaveBeenCalledTimes(4); expect(http).not.toHaveBeenCalled();
  scenario.acquire.mockReset();
  scenario.acquire.mockResolvedValueOnce({ ok: false, reason: 'minute', retryAfterMs: 1 } as any).mockResolvedValue({ ok: true, token: 'cron-token-SENTINEL' });
  const retry = refreshRail(scenario.env);
  await vi.advanceTimersByTimeAsync(1); await retry;
  expect(http).toHaveBeenCalledTimes(1);
});
it('logs monitoring and warns when usage is at least seventy percent', async () => {
  await seed(); const scenario = cronEnv(), log = vi.spyOn(console, 'log').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  scenario.usage.mockResolvedValue({ ...(await scenario.usage()), pct: 70 });
  await refreshRail(scenario.env);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^tdx usage /)); expect(warn).toHaveBeenCalledWith('tdx usage at least 70%');
});

it.each([{}, { 'X-TDX-Client-Id': 'user-id-SENTINEL', 'X-TDX-Client-Secret': 'user-secret-SENTINEL' }, { 'X-TDX-Client-Id': 'only-one-SENTINEL' }])('keeps invoice responses independent of rail credentials %j', async headers => {
  const snapshot = await buildInvoiceSnapshot(async () => xml);
  await bindings.SNAPSHOTS.put(keys.invoice, encodeSnapshot(snapshot));
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('invoice must not fetch'));
  const response = await rpc('invoice_get_winning_numbers', {}, { headers: headers as Record<string, string> });
  expect(response.status).toBe(200); expect(response.result.isError).not.toBe(true);
  expect(response.result.content[0].text).toContain('統一發票中獎號碼'); expect(http).not.toHaveBeenCalled();
});
