import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { directoryStore, main, publishRail } from '../scripts/publish-rail.js';
import { compactStations, stationKey, timetableKey } from '../src/core/rail/snapshot.js';
import { snapshotUsageKey } from '../src/worker/snapshot-keys.js';
import thsrStations from './fixtures/tdx/real/thsr-stations.json';
import traStations from './fixtures/tdx/real/tra-stations.json';
import thsrOD from './fixtures/tdx/real/thsr-od-1000-1070.json';
import traOD from './fixtures/tdx/real/tra-od-1000-4400.json';
const thsrDaily = thsrOD.map(row => ({ DailyTrainInfo: row.DailyTrainInfo, StopTimes: [row.OriginStopTime, row.DestinationStopTime] }));
const now = new Date('2026-10-29T00:23:00+08:00'), today = '2026-10-29', tomorrow = '2026-10-30';
const credentials = { TDX_CLIENT_ID: ' id-SENTINEL ', TDX_CLIENT_SECRET: ' secret-SENTINEL ' };
const cloud = { CLOUDFLARE_ACCOUNT_ID: 'account', KV_NAMESPACE_ID: 'namespace', CLOUDFLARE_KV_WRITE_TOKEN: 'kv-token-SENTINEL' };
const usageKey = snapshotUsageKey('2026-10');
const keyOrder = [timetableKey('THSR', today), timetableKey('TRA', today), stationKey('THSR'), stationKey('TRA'), timetableKey('THSR', tomorrow), timetableKey('TRA', tomorrow)];
let dir: string;
let tdx: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'publish-rail-'));
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  tdx = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith('/token')) {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'client_credentials', client_id: 'id-SENTINEL', client_secret: 'secret-SENTINEL' });
      return Response.json({ access_token: 'access-SENTINEL', expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-SENTINEL');
    if (url.includes('/Station?')) return Response.json(url.includes('/THSR/') ? thsrStations : traStations);
    return Response.json(url.includes('/THSR/') ? thsrDaily : traOD);
  });
  vi.stubGlobal('fetch', tdx);
});
afterEach(async () => {
  const logs = ['log', 'warn', 'error'].flatMap(method => vi.mocked(console[method as 'log']).mock.calls).flat().join('\n');
  for (const secret of ['id-SENTINEL', 'secret-SENTINEL', cloud.CLOUDFLARE_KV_WRITE_TOKEN]) expect(logs).not.toContain(secret);
  expect(logs.split('\n').filter(line => line.includes('access-SENTINEL')).every(line => line === '::add-mask::access-SENTINEL')).toBe(true);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const publish = (opts: Partial<Parameters<typeof publishRail>[0]> = {}) => publishRail({ outDir: dir, env: credentials, now, intervalMs: 0, ...opts });
const read = async (key: string) => JSON.parse((await directoryStore(dir).get(key))!);
async function seed() { expect(await publish()).toBe(0); tdx.mockClear(); }

it.each([{}, { TDX_CLIENT_ID: ' ' }, { TDX_CLIENT_SECRET: '' }])('skips absent trimmed credentials before any storage or fetch', async env => {
  expect(await publishRail({ env: { ...credentials, ...env, ...(Object.keys(env).length ? {} : { TDX_CLIENT_ID: undefined }) } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledExactlyOnceWith('::notice::rail snapshot skipped: TDX_CLIENT_ID/TDX_CLIENT_SECRET not set');
});
it.each(Object.keys(cloud))('KV mode prints only missing %s and exits 2', async name => {
  expect(await publishRail({ env: { ...credentials, ...cloud, [name]: '' } })).toBe(2);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(name); expect(fetch).not.toHaveBeenCalled();
});
it('writes prioritized snapshots, metadata and usage locally; steady state has zero TDX calls', async () => {
  const bulkFile = join(dir, 'bulk.json');
  expect(await publish({ bulkFile })).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(7);
  const bulk = JSON.parse(await readFile(bulkFile, 'utf8'));
  expect(bulk.map((entry: { key: string }) => entry.key)).toEqual([usageKey, ...keyOrder]);
  for (const entry of bulk) {
    expect(entry.value).toBe(await directoryStore(dir).get(entry.key));
    expect(entry.expiration_ttl).toBe(entry.key === usageKey ? 5356800 : entry.key.includes(':timetable:') ? 259200 : undefined);
    const metadata = JSON.parse(await readFile(join(dir, `${entry.key.replaceAll(':', '_')}.meta.json`), 'utf8'));
    expect(metadata).toMatchObject({ fetchedAt: expect.any(String), dataDate: entry.key.includes(tomorrow) ? tomorrow : today });
    if (entry.key.includes(tomorrow)) expect(metadata.dataDate).toBe(tomorrow);
  }
  expect(await read(usageKey)).toMatchObject({ v: 1, month: '2026-10', days: { [today]: 7 }, total: 7 });
  tdx.mockClear();
  expect(await publish()).toBe(0); expect(fetch).not.toHaveBeenCalled();
  expect(await read(usageKey)).toMatchObject({ total: 7 });
  expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^rail collector calls=0 elapsedMs=\d+ bytes=0$/));
});
it('on the next day only fills the new tomorrow and updates monthly/day usage', async () => {
  await seed();
  expect(await publish({ now: new Date('2026-10-30T00:23:00+08:00') })).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(tdx.mock.calls.slice(1).every(([url]) => String(url).includes('/TrainDate/2026-10-31'))).toBe(true);
  expect(await read(usageKey)).toMatchObject({ days: { [today]: 7, [tomorrow]: 3 }, total: 10 });
});
it('refreshes stations only when absent, invalid or older than seven days', async () => {
  await seed();
  const key = stationKey('TRA'), store = directoryStore(dir);
  await store.put(key, JSON.stringify(compactStations('TRA', traStations, '2026-10-21T16:23:00Z')), { metadata: { fetchedAt: '', dataDate: '' } });
  expect(await publish()).toBe(0); expect(fetch).not.toHaveBeenCalled(); // exactly seven days
  await store.put(key, JSON.stringify(compactStations('TRA', traStations, '2026-10-21T16:22:59Z')), { metadata: { fetchedAt: '', dataDate: '' } });
  expect(await publish()).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([2, 3])('pages TRA up to %i pages and marks a capped response', async pages => {
  await seed(); await rm(join(dir, `${timetableKey('TRA', today).replaceAll(':', '_')}.json`));
  const original = tdx.getMockImplementation()!;
  tdx.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/token')) return original(input, init);
    const page = Number(new URL(String(input)).searchParams.get('$skip') ?? 0) / 1000;
    return Response.json({ TrainTimetables: Array.from({ length: pages === 2 && page === 1 ? 1 : 1000 }, () => traOD.TrainTimetables[0]) });
  });
  expect(await publish()).toBe(0);
  expect(tdx.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('$skip'))).toEqual(pages === 2 ? [null, '1000'] : [null, '1000', '2000']);
  const snapshot = await read(timetableKey('TRA', today));
  expect(snapshot.trains).toHaveLength(pages === 2 ? 1001 : 3000); expect(snapshot.truncated).toBe(pages === 3);
});
it.each([false, true])('replaces a data 401 token once (repeated=%s), counting every attempt', async repeat => {
  let attempts = 0;
  const original = tdx.getMockImplementation()!;
  tdx.mockImplementation(async (input, init) => String(input).includes(`/THSR/DailyTimetable/TrainDate/${today}`) && (++attempts === 1 || repeat)
    ? new Response('private-body', { status: 401 }) : original(input, init));
  expect(await publish({ env: { ...credentials, GITHUB_ACTIONS: 'true' } })).toBe(repeat ? 1 : 0);
  expect(attempts).toBe(2);
  expect(tdx.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(repeat ? 3 : 2);
  expect((await read(usageKey)).total).toBe(repeat ? 10 : 9);
  expect(console.log).toHaveBeenCalledWith('::add-mask::access-SENTINEL');
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-body');
});
it.each(['network', 'http', 'invalid', 'empty'])('keeps partial successes on %s failure and counts failed calls', async failure => {
  const original = tdx.getMockImplementation()!;
  tdx.mockImplementation(async (input, init) => {
    if (!String(input).includes(`/TRA/DailyTrainTimetable/TrainDate/${today}`)) return original(input, init);
    if (failure === 'network') throw new Error('private-body access-SENTINEL');
    if (failure === 'http') return new Response('private-body', { status: 500 });
    return Response.json(failure === 'empty' ? { TrainTimetables: [] } : { private: 'private-body' });
  });
  expect(await publish()).toBe(1);
  expect(await directoryStore(dir).get(timetableKey('TRA', today))).toBeNull();
  expect(await directoryStore(dir).get(timetableKey('THSR', tomorrow))).not.toBeNull();
  expect((await read(usageKey)).total).toBe(7);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-body');
});
it.each(['http', 'network'])('counts token %s failure and records it despite failed keys', async failure => {
  if (failure === 'network') tdx.mockRejectedValue(new Error('private-body'));
  else tdx.mockResolvedValue(new Response('private-body', { status: 403 }));
  expect(await publish({ maxCalls: 1 })).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1); expect((await read(usageKey)).total).toBe(1);
});
it.each([1, 2])('persists usage before call %i hangs then rejects', async call => {
  const original = tdx.getMockImplementation()!;
  let reject: ((error: Error) => void) | undefined;
  tdx.mockImplementation(async (input, init) => tdx.mock.calls.length === call
    ? new Promise<Response>((_, fail) => { reject = fail; }) : original(input, init));
  const work = publish({ maxCalls: call });
  await vi.waitFor(() => expect(reject).toBeDefined());
  expect(await read(usageKey)).toMatchObject({ days: { [today]: call }, total: call, updatedAt: expect.any(String) });
  reject!(new Error('private-body'));
  expect(await work).toBe(1);
  expect(tdx).toHaveBeenCalledTimes(call);
  expect((await read(usageKey)).total).toBe(call);
});
it('honours a small call budget in priority order', async () => {
  expect(await publish({ maxCalls: 3 })).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await directoryStore(dir).get(keyOrder[0])).not.toBeNull();
  expect(await directoryStore(dir).get(keyOrder[1])).not.toBeNull();
  expect(await directoryStore(dir).get(stationKey('THSR'))).toBeNull();
  expect((await read(usageKey)).total).toBe(3);
});
it('stops between pages without publishing an incomplete timetable', async () => {
  const original = tdx.getMockImplementation()!;
  tdx.mockImplementation(async (input, init) => String(input).includes('/TRA/DailyTrainTimetable/')
    ? Response.json({ TrainTimetables: Array.from({ length: 1000 }, () => traOD.TrainTimetables[0]) }) : original(input, init));
  expect(await publish({ maxCalls: 3 })).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await directoryStore(dir).get(timetableKey('TRA', today))).toBeNull();
});
it('stops exactly at the monthly self-limit and refuses new calls on the next run', async () => {
  await writeFile(join(dir, `${usageKey.replaceAll(':', '_')}.json`), JSON.stringify({ v: 1, month: '2026-10', days: { [today]: 198 }, total: 198, updatedAt: now.toISOString() }));
  expect(await publish()).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
  expect((await read(usageKey)).total).toBe(200);
  tdx.mockClear();
  expect(await publish()).toBe(0); expect(fetch).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith('::warning::rail snapshot monthly reserve exhausted');
});
it('allows zero reserve and uses the Taipei month for usage', async () => {
  expect(await publish({ env: { ...credentials, TDX_SNAPSHOT_RESERVE: '0' }, now: new Date('2026-10-31T16:00:00Z') })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith('rail skip rail:timetable:THSR:2026-11-01:v1 call limit');
});
it.each(['', '9999'])('clamps reserve %j to the configured monthly quota', async reserve => {
  expect(await publish({ env: { ...credentials, TDX_SNAPSHOT_RESERVE: reserve, TDX_MONTHLY_QUOTA: '3' } })).toBe(0);
  expect(tdx).toHaveBeenCalledTimes(3);
  expect((await read(usageKey)).total).toBe(3);
});
it('paces token and data calls by the interval', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const times: number[] = [], original = tdx.getMockImplementation()!;
  tdx.mockImplementation(async (input, init) => { times.push(Date.now()); return original(input, init); });
  const work = publish({ intervalMs: 15000 });
  // Directory reads use real I/O; advance each pending timer as it appears.
  for (let i = 0; i < 7; i++) {
    await vi.waitFor(() => expect(times).toHaveLength(i + 1));
    await vi.advanceTimersByTimeAsync(15000);
  }
  expect(await work).toBe(0);
  expect(times.slice(1).every((time, i) => time - times[i] >= 15000)).toBe(true);
});
it('honours the loopback TDX override', async () => {
  expect(await publish({ env: { ...credentials, TDX_BASE_URL: 'http://127.0.0.1:8790/path' } })).toBe(0);
  expect(tdx.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:8790/'))).toBe(true);
});
it.each([['--out'], ['--max-calls', '-1'], ['--interval-ms', '1.5'], ['--bad', 'x']])('rejects invalid CLI arguments %j', async (...args) => {
  expect(await main(args)).toBe(2); expect(fetch).not.toHaveBeenCalled();
});
it('requires local mode for bulk export', async () => {
  expect(await publishRail({ env: { ...credentials, ...cloud }, bulkFile: join(dir, 'bulk.json') })).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('KV uses encoded keys, multipart metadata, correct TTLs and never prints error bodies', async () => {
  const values = new Map<string, string>(), writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.cloudflare.com') {
      expect(JSON.parse(values.get(usageKey)!)).toMatchObject({ total: tdx.mock.calls.length + 1, days: { [today]: tdx.mock.calls.length + 1 } });
      return tdx(input, init);
    }
    expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${cloud.CLOUDFLARE_KV_WRITE_TOKEN}`);
    const encoded = url.pathname.split('/').at(-1)!;
    const key = decodeURIComponent(encoded);
    expect(encoded).toBe(encodeURIComponent(key));
    if (init?.method !== 'PUT') return values.has(key) ? new Response(values.get(key)) : new Response(null, { status: 404 });
    writes.push(key);
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(Object.keys(JSON.parse(String(body.get('metadata'))))).toEqual(['fetchedAt', 'dataDate']);
    expect(url.searchParams.get('expiration_ttl')).toBe(key === usageKey ? '5356800' : key.includes(':timetable:') ? '259200' : null);
    if (key === stationKey('TRA')) return Response.json({ success: false, errors: [{ message: 'private-body' }] }, { status: 403 });
    values.set(key, String(body.get('value'))); return Response.json({ success: true });
  }));
  expect(await publishRail({ env: { ...credentials, ...cloud }, now, intervalMs: 0 })).toBe(1);
  expect(writes).toEqual([usageKey, ...keyOrder.flatMap(key => [usageKey, key])]);
  expect(JSON.parse(values.get(usageKey)!)).toMatchObject({ total: 7 });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-body');
});
it.each([1, 3])('stops TDX calls when usage write %i fails', async failAt => {
  let writes = 0, stored: string | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.cloudflare.com') return tdx(input, init);
    const key = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (init?.method !== 'PUT') return key === usageKey && stored ? new Response(stored) : new Response(null, { status: 404 });
    if (key === usageKey) {
      if (++writes === failAt) return Response.json({ success: false }, { status: 500 });
      stored = String((init.body as FormData).get('value'));
    }
    return Response.json({ success: true });
  }));
  expect(await publishRail({ env: { ...credentials, ...cloud }, now, intervalMs: 0 })).toBe(1);
  expect(writes).toBe(failAt);
  expect(tdx).toHaveBeenCalledTimes(failAt - 1);
  if (stored) expect(JSON.parse(stored)).toMatchObject({ total: failAt - 1, days: { [today]: failAt - 1 } });
  expect(console.error).toHaveBeenCalledWith(`rail skip ${usageKey} put failed`);
});
it('aborts before TDX when the usage KV read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private-body', { status: 500 })));
  expect(await publishRail({ env: { ...credentials, ...cloud }, intervalMs: 0 })).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1); expect(tdx).not.toHaveBeenCalled();
});

it('workflow pins actions, guards every subsequent step and keeps secrets out of shell scripts', async () => {
  const text = await readFile('.github/workflows/rail-snapshot.yml', 'utf8');
  expect(text).toContain("cron: '23 16,20 * * *'");
  expect(text).toContain('workflow_dispatch:');
  expect(text).toContain('permissions:\n  contents: read');
  expect(text).toContain('group: rail-snapshot\n  cancel-in-progress: false');
  expect(text).toContain('runs-on: ubuntu-latest\n    timeout-minutes: 5');
  expect(text).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
  expect(text).toContain('KV_NAMESPACE_ID: e92149e1efec4434835310d434b69f7d');
  expect(text.slice(text.indexOf('run: node scripts/dist/publish-rail.mjs'))).toContain('          TDX_SNAPSHOT_RESERVE: ${{ vars.TDX_SNAPSHOT_RESERVE }}');
  expect(text.slice(text.indexOf('run: node scripts/dist/publish-rail.mjs'))).toContain('          TDX_MONTHLY_QUOTA: ${{ vars.TDX_MONTHLY_QUOTA }}');
  expect(text).toContain('persist-credentials: false');
  expect(text).toContain('node-version: 20');
  const actions = [...text.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  expect(actions).toEqual(['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020']);
  const guard = text.indexOf('- id: guard'), run = text.indexOf('run: node scripts/dist/publish-rail.mjs');
  expect(guard).toBeLessThan(run);
  expect(text).toContain('[ -n "$TDX_CLIENT_ID" ] && [ -n "$TDX_CLIENT_SECRET" ]');
  expect(text.match(/if: steps.guard.outputs.enabled == 'true'/g)).toHaveLength(4);
  let inRun = false;
  for (const line of text.split('\n')) {
    if (/^        run:/.test(line)) inRun = true;
    else if (/^\S|^ {0,8}\S/.test(line)) inRun = false;
    if (inRun) expect(line).not.toContain('secrets.');
  }
  expect(text).not.toMatch(/run:.*npm ci/);
});
