import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TdxGateway, type TdxEnv } from '../../src/worker/tdx-gateway.js';
import type { Env } from '../../src/worker/index.js';
import { workerRail } from '../../src/worker/rail.js';
const bindings = env as unknown as Env;
const credentials = { TDX_CLIENT_ID: 'project-id-SENTINEL', TDX_CLIENT_SECRET: 'project-secret-SENTINEL' };
const path = (no: number) => `/v3/Rail/TRA/TrainLiveBoard/TrainNo/${no}`;
// Each test uses a fresh real SQLite DO and injects fake secrets inside its context.
const stub = () => bindings.TDX_GATEWAY.get(bindings.TDX_GATEWAY.idFromName(crypto.randomUUID()));
async function setup(overrides: Partial<TdxEnv> = {}) {
  const target = stub();
  await runInDurableObject(target, (instance, ctx) => {
    // Date is mocked independently of workerd's alarm clock; invoke alarms explicitly below.
    vi.spyOn(ctx.storage, 'setAlarm').mockResolvedValue();
    const state = instance as unknown as { env: TdxEnv };
    state.env = { ...state.env, ...credentials, ...overrides };
  });
  return target;
}
const mockHttp = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('/token')
  ? Response.json({ access_token: 'project-token-SENTINEL', expires_in: 86400, token_type: 'Bearer' })
  : Response.json({ TrainLiveBoards: [{ TrainNo: '123' }] }));
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP must be mocked')); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00Z')); });
afterEach(() => {
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  vi.useRealTimers(); vi.restoreAllMocks();
});
it('degrades a token redirect to non-error fallback text without following it', async () => {
  const target = await setup();
  const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.example/token' } }));
  const namespace = { idFromName: () => target.id, get: () => target };
  const result = await workerRail({ ...bindings, ...credentials, TDX_GATEWAY: namespace as unknown as Env['TDX_GATEWAY'] }, 'ip', undefined).live({ train_no: '123' });
  expect(result.isError).not.toBe(true);
  expect(result.text).toContain('即時誤點暫時無法提供');
  expect(http).toHaveBeenCalledTimes(1);
  expect(String(http.mock.calls[0][0])).toContain('https://tdx.transportdata.tw/');
});
it('admits exactly four total calls in a concurrent burst of twenty distinct paths, counting token', async () => {
  const target = await setup(), http = mockHttp();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => target.live(path(100 + i), `ip-${i}`)));
  expect(http).toHaveBeenCalledTimes(4);
  expect(results.filter(r => r.ok)).toHaveLength(3);
  expect(results.filter(r => !r.ok && r.reason === 'minute')).toHaveLength(17);
  expect(await target.usage()).toMatchObject({ monthUsed: 4, todayUsed: 4, last60s: 4, byPurpose: { token: 1, live: 3, snapshot: 0 } });
});
it('starts and counts a distinct live miss while the first data fetch is unresolved', async () => {
  const target = await setup();
  await runInDurableObject(target, async instance => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/token')) return Response.json({ access_token: 'project-token-SENTINEL', expires_in: 86400 });
      if (new URL(String(input)).pathname.endsWith(path(1))) { started(); await held; }
      return Response.json({ TrainLiveBoards: [{ TrainNo: '123' }] });
    });
    const first = instance.live(path(1), 'ip-1');
    await firstStarted;
    const second = instance.live(path(2), 'ip-2');
    try {
      await vi.waitFor(() => expect(http.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith(path(2)))).toBe(true));
      expect(await second).toMatchObject({ ok: true });
      expect(await instance.usage()).toMatchObject({ monthUsed: 3, todayUsed: 3, last60s: 3, byPurpose: { token: 1, live: 2, snapshot: 0 } });
    } finally { release(); await Promise.all([first, second]); }
    expect(await first).toMatchObject({ ok: true }); expect(http).toHaveBeenCalledTimes(3);
  });
});
it('deduplicates concurrent identical paths and serves two-minute cache hits for free', async () => {
  const target = await setup(), http = mockHttp();
  const results = await Promise.all(Array.from({ length: 20 }, () => target.live(path(123), 'one-ip')));
  expect(results.every(r => r.ok)).toBe(true); expect(http).toHaveBeenCalledTimes(2);
  const first = results[0];
  vi.setSystemTime(Date.now() + 119999);
  expect(await target.live(path(123), 'another-ip')).toEqual(first); expect(http).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 1);
  expect(await target.live(path(123), 'another-ip')).toMatchObject({ ok: true }); expect(http).toHaveBeenCalledTimes(3);
  expect(http.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
});
it('persists the token in SQLite and reuses it in a later minute and a fresh instance', async () => {
  const target = await setup(), http = mockHttp();
  await target.live(path(1), 'ip');
  vi.setSystemTime(Date.now() + 60000);
  await runInDurableObject(target, async (_instance, ctx) => {
    const restarted = new TdxGateway(ctx, { ...bindings, ...credentials });
    expect(await restarted.live(path(2), 'ip')).toMatchObject({ ok: true });
  });
  expect(http).toHaveBeenCalledTimes(3);
  expect((await target.usage()).byPurpose.token).toBe(1);
});
it('invalidates only the matching token and counts its replacement', async () => {
  const target = await setup(), http = mockHttp();
  expect(await target.acquire('snapshot')).toMatchObject({ ok: true, token: 'project-token-SENTINEL' });
  await target.invalidate('stale-token');
  expect(await target.acquire('snapshot')).toMatchObject({ ok: true, token: 'project-token-SENTINEL' });
  vi.setSystemTime(Date.now() + 60000);
  await target.invalidate('project-token-SENTINEL');
  // Create the response in the calling Durable Object's I/O context.
  http.mockImplementation(async () => Response.json({ access_token: 'replacement-token', expires_in: 3600 }));
  expect(await target.acquire('snapshot')).toMatchObject({ ok: true, token: 'replacement-token' });
  await target.invalidate('project-token-SENTINEL');
  expect(await target.acquire('snapshot')).toMatchObject({ ok: true, token: 'replacement-token' });
  expect(http).toHaveBeenCalledTimes(2);
  expect(await target.usage()).toMatchObject({ monthUsed: 6, byPurpose: { token: 2, snapshot: 4 } });
});
async function seed(target: ReturnType<typeof stub>, day: string, purpose: string, count: number) {
  await runInDurableObject(target, (_instance, ctx) => {
    ctx.storage.sql.exec('INSERT OR REPLACE INTO tdx_days(day,purpose,count) VALUES(?,?,?)', day, purpose, count);
  });
}
it('enforces daily budget, but lets snapshots bypass it', async () => {
  const target = await setup(), http = mockHttp();
  await seed(target, '2026-10-01', 'live', 130);
  expect(await target.live(path(1), 'ip')).toMatchObject({ ok: false, reason: 'daily' });
  expect(http).not.toHaveBeenCalled();
  expect(await target.acquire('snapshot')).toMatchObject({ ok: true, token: 'project-token-SENTINEL' });
  expect(http).toHaveBeenCalledTimes(1); // Cron owns the already-accounted data call.
  expect((await target.usage()).monthUsed).toBe(132);
});
it('stops live at ninety percent and snapshots at one hundred percent', async () => {
  const target = await setup(), http = mockHttp();
  vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
  await seed(target, '2026-10-01', 'live', 4050);
  expect(await target.live(path(1), 'ip')).toMatchObject({ ok: false, reason: 'monthly' });
  expect(await target.acquire('snapshot')).toMatchObject({ ok: true });
  expect(http).toHaveBeenCalledTimes(1);
  await seed(target, '2026-10-01', 'live', 4498);
  expect(await target.acquire('snapshot')).toMatchObject({ ok: false, reason: 'monthly' });
  expect(http).toHaveBeenCalledTimes(1);
});
it('applies the snapshot twenty-call day guard and lower demo quota', async () => {
  const target = await setup({ TDX_MONTHLY_QUOTA: '100' }), http = mockHttp();
  await seed(target, '2026-10-01', 'snapshot', 19);
  expect(await target.acquire('snapshot')).toMatchObject({ ok: false, reason: 'daily' });
  expect((await target.usage()).liveCeiling).toBe(90); expect(http).not.toHaveBeenCalled();
});
it('allows six upstream-triggering misses per IP per hour, with free hits and independent IPs', async () => {
  const target = await setup(), http = mockHttp();
  for (let i = 0; i < 6; i++) {
    vi.setSystemTime(Date.now() + 61000);
    expect(await target.live(path(i), 'same-ip')).toMatchObject({ ok: true });
  }
  expect(await target.live(path(5), 'same-ip')).toMatchObject({ ok: true });
  expect(await target.live(path(7), 'same-ip')).toMatchObject({ ok: false, reason: 'ip' });
  expect(await target.live(path(7), 'other-ip')).toMatchObject({ ok: true });
  expect(http).toHaveBeenCalledTimes(8);
  vi.setSystemTime(Date.now() + 3600_000);
  expect(await target.live(path(8), 'same-ip')).toMatchObject({ ok: true });
});
it('persists hourly IP misses across a fresh instance and prunes expired rows', async () => {
  const target = await setup(), http = mockHttp(), ip = '2001:db8:1234:5678::/64';
  for (let i = 0; i < 6; i++) {
    vi.setSystemTime(Date.now() + 61000);
    expect(await target.live(path(i), ip)).toMatchObject({ ok: true });
  }
  await runInDurableObject(target, async (_instance, ctx) => {
    expect(ctx.storage.sql.exec('SELECT DISTINCT ip FROM tdx_ip_misses').toArray()).toEqual([{ ip }]);
    const restarted = new TdxGateway(ctx, { ...bindings, ...credentials });
    expect(await restarted.live(path(7), ip)).toMatchObject({ ok: false, reason: 'ip' });
    expect(await restarted.live(path(7), '192.0.2.1')).toMatchObject({ ok: true });
    vi.setSystemTime(Date.now() + 3600_000);
    expect(await restarted.live(path(8), ip)).toMatchObject({ ok: true });
    expect(ctx.storage.sql.exec('SELECT ip, at FROM tdx_ip_misses').toArray()).toEqual([{ ip, at: Date.now() }]);
  });
  expect(http).toHaveBeenCalledTimes(9);
});
it.each([400, 401, 403])('counts token authentication failure %i without logging secrets', async status => {
  const target = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ secret: credentials.TDX_CLIENT_SECRET }, { status }));
  expect(await target.live(path(1), 'ip')).toMatchObject({ ok: false, reason: 'auth' });
  expect(http).toHaveBeenCalledTimes(1); expect((await target.usage()).monthUsed).toBe(1);
  expect(warn).toHaveBeenCalledWith('tdx token authentication failed');
  expect(JSON.stringify(warn.mock.calls)).not.toContain(credentials.TDX_CLIENT_SECRET);
});
it.each(['token-network', 'data-network', 'data-status'] as const)('counts and never caches %s failures', async failure => {
  const target = await setup(), http = mockHttp();
  http.mockImplementation(async input => {
    if (String(input).endsWith('/token')) {
      if (failure === 'token-network') throw new Error(credentials.TDX_CLIENT_SECRET);
      return Response.json({ access_token: 'project-token-SENTINEL', expires_in: 86400 });
    }
    if (failure === 'data-network') throw new Error('project-token-SENTINEL');
    return Response.json({}, { status: 503 });
  });
  expect(await target.live(path(1), 'ip')).toMatchObject({ ok: false, reason: 'upstream' });
  expect((await target.usage()).monthUsed).toBe(failure === 'token-network' ? 1 : 2);
  await target.live(path(1), 'ip');
  expect(http).toHaveBeenCalledTimes(failure === 'token-network' ? 2 : 3);
});
it('rejects missing credentials and paths outside the two safe live shapes without fetching', async () => {
  const target = await setup({ TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined }), http = mockHttp();
  expect(await target.live(path(1), 'ip')).toMatchObject({ ok: false, reason: 'nokey' });
  for (const value of ['/v3/Rail/TRA/Station', `${path(1)}?x=1`, `${path(1)}/../2`, '/v3/Rail/TRA/StationLiveBoard/Station/a%2fb']) expect(await target.live(value, 'ip')).toMatchObject({ ok: false });
  expect(http).not.toHaveBeenCalled();
});
it('publishes secret-free monitoring at most once per fifteen minutes when counts change', async () => {
  const target = await setup(), http = mockHttp(), writes: string[] = [];
  await runInDurableObject(target, instance => {
    const state = instance as unknown as { env: TdxEnv }, kv = state.env.SNAPSHOTS;
    state.env = { ...state.env, SNAPSHOTS: { async put(key: string, value: string) {
      if (key === 'tdx:usage:v1') writes.push(value);
      await kv.put(key, value);
    } } as KVNamespace };
  });
  await target.live(path(1), 'private-ip-key');
  await target.live(path(2), 'private-ip-key');
  // Flush waitUntil work before inspecting monitoring.
  await runInDurableObject(target, async (_instance, ctx) => { await ctx.storage.sync(); });
  expect(writes).toHaveLength(1);
  vi.setSystemTime(Date.now() + 900_000);
  await runInDurableObject(target, instance => instance.alarm());
  expect(writes).toHaveLength(2);
  const serialized = JSON.stringify(await target.usage());
  for (const value of [...Object.values(credentials), 'project-token-SENTINEL', 'private-ip-key']) expect(serialized).not.toContain(value);
  expect(http).toHaveBeenCalledTimes(3);
});

it('counts failed token attempts as upstream-triggering IP misses', async () => {
  const target = await setup(), http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline token'));
  for (let i = 0; i < 6; i++) {
    vi.setSystemTime(Date.now() + 61000);
    expect(await target.live(path(i), 'one-ip')).toMatchObject({ ok: false, reason: 'upstream' });
  }
  vi.setSystemTime(Date.now() + 61000);
  expect(await target.live(path(7), 'one-ip')).toMatchObject({ ok: false, reason: 'ip' });
  expect(http).toHaveBeenCalledTimes(6);
});
it('resets Taipei month/day totals while preserving the sliding minute and persisted token', async () => {
  const target = await setup(), http = mockHttp();
  vi.setSystemTime(new Date('2026-10-31T15:59:59Z'));
  for (let i = 0; i < 3; i++) expect(await target.live(path(i), 'ip')).toMatchObject({ ok: true });
  expect((await target.usage()).monthUsed).toBe(4);
  vi.setSystemTime(new Date('2026-10-31T16:00:00Z'));
  expect(await target.usage()).toMatchObject({ month: '2026-11', today: '2026-11-01', monthUsed: 0, todayUsed: 0, last60s: 4 });
  expect(await target.live(path(4), 'ip')).toMatchObject({ ok: false, reason: 'minute' });
  vi.setSystemTime(Date.now() + 60000);
  expect(await target.live(path(4), 'ip')).toMatchObject({ ok: true });
  expect(await target.usage()).toMatchObject({ monthUsed: 1, todayUsed: 1, byPurpose: { token: 0, live: 1, snapshot: 0 } });
  expect(http).toHaveBeenCalledTimes(5);
});
it('prunes old day and minute rows without losing current-month counts', async () => {
  const target = await setup(); mockHttp();
  await seed(target, '2026-07-01', 'live', 20);
  await seed(target, '2026-09-30', 'snapshot', 5);
  await target.live(path(1), 'ip');
  vi.setSystemTime(Date.now() + 61000);
  expect((await target.usage()).last60s).toBe(0);
  await runInDurableObject(target, (_instance, ctx) => {
    expect(ctx.storage.sql.exec('SELECT day FROM tdx_days ORDER BY day').toArray()).toEqual([{ day: '2026-09-30' }, { day: '2026-10-01' }, { day: '2026-10-01' }]);
    expect(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM tdx_calls').one()).toEqual({ n: 0 });
  });
});
