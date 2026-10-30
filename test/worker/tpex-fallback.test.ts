import { env, createExecutionContext, createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import worker, { keys, metaKeys, type Env } from '../../src/worker/index.js';
import { collectKeys } from '../../src/worker/snapshot-keys.js';
import { stockUrls } from '../../src/core/stock/source.js';
import xml from '../fixtures/invoice.xml?raw';
const token = 'ghp_SENTINEL_DO_NOT_LOG_123';
const bindings = { ...env, GH_DISPATCH_TOKEN: token } as unknown as Env;
const url = 'https://api.github.com/repos/ycsmiley/formosa-mcp/actions/workflows/tpex-collect.yml/dispatches';
const capKey = 'tpex:fallback:2026-10-30';
const heartbeat = { v: 1, lastSuccessAt: '2026-10-29T10:47:00Z', dataDate: '2026-10-29' };
const run = (time = '2026-10-30T11:00:00Z', cron = '0,30 * * * MON-FRI', target = bindings) => worker.scheduled(createScheduledController({ cron, scheduledTime: Date.parse(time) }), target, createExecutionContext());
const reset = async () => {
  for (const key of [...Object.values(keys), ...Object.values(metaKeys), collectKeys.tpex, capKey, 'tpex:fallback:2026-10-29', 'tpex:fallback:2026-10-31']) await bindings.SNAPSHOTS.delete(key);
};
const mockFetch = (dispatch = async () => new Response(null, { status: 204 })) => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  if (String(input) === url) return dispatch();
  if (String(input).includes('invoice.xml')) return new Response(xml);
  if (Object.entries(stockUrls).some(([key, value]) => key.startsWith('twse') && value === String(input))) return new Response(null, { status: 304 });
  throw new Error('unexpected fetch');
});
const dispatches = (fetch: ReturnType<typeof mockFetch>) => fetch.mock.calls.filter(([input]) => String(input) === url);
let logs: Record<'log' | 'warn' | 'error', MockInstance>;
beforeEach(async () => {
  await reset();
  logs = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
});
afterEach(async () => {
  try {
    for (const method of ['log', 'warn', 'error'] as const) {
      expect(logs[method].mock.calls.some(args => args.some(arg => String(arg).includes(token)))).toBe(false);
    }
  } finally { vi.restoreAllMocks(); await reset(); }
});
it('dispatches stale TPEx independently of TWSE with a persisted count, TTL and exact request', async () => {
  await bindings.SNAPSHOTS.put(collectKeys.tpex, JSON.stringify(heartbeat));
  const put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  const fetch = mockFetch(async () => {
    expect(await bindings.SNAPSHOTS.get(capKey)).toBe('1');
    return new Response(null, { status: 204 });
  });
  await run('2026-10-30T11:00:59.999Z');
  expect(dispatches(fetch)).toHaveLength(1);
  const [input, init] = dispatches(fetch)[0];
  expect(input).toBe(url);
  expect(init).toEqual({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: '{"ref":"main"}', headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)', 'Content-Type': 'application/json',
  } });
  expect(put).toHaveBeenCalledExactlyOnceWith(capKey, '1', { expirationTtl: 259200 });
  expect(logs.log).toHaveBeenCalledWith('tpex fallback dispatch status=204');
  expect(logs.log).toHaveBeenCalledWith('stock:twse 304 skip');
});
it.each(['2026-10-30T11:00:00Z', '2026-10-30T12:30:00Z'])('skips a fresh heartbeat at %s', async time => {
  await bindings.SNAPSHOTS.put(collectKeys.tpex, JSON.stringify({ ...heartbeat, dataDate: '2026-10-30' }));
  const fetch = mockFetch();
  await run(time);
  expect(dispatches(fetch)).toHaveLength(0);
  expect(await bindings.SNAPSHOTS.get(capKey)).toBeNull();
  expect(logs.log).toHaveBeenCalledWith('tpex fallback fresh');
});
it.each([null, 'invalid', JSON.stringify({ ...heartbeat, dataDate: '2026-02-30' }), JSON.stringify({ ...heartbeat, dataDate: '2026-10-30', lastSuccessAt: 'invalid' })])('dispatches with missing or invalid heartbeat %j', async value => {
  if (value !== null) await bindings.SNAPSHOTS.put(collectKeys.tpex, value);
  const fetch = mockFetch();
  await run();
  expect(dispatches(fetch)).toHaveLength(1);
});
it('caps attempts at two per Taipei date, including the 12:30 UTC run', async () => {
  await bindings.SNAPSHOTS.put(collectKeys.tpex, JSON.stringify(heartbeat));
  const fetch = mockFetch();
  await run(); await run('2026-10-30T12:30:00Z'); await run('2026-10-30T12:30:00Z');
  expect(dispatches(fetch)).toHaveLength(2);
  expect(await bindings.SNAPSHOTS.get(capKey)).toBe('2');
  expect(await bindings.SNAPSHOTS.get('tpex:fallback:2026-10-31')).toBeNull();
  expect(logs.log).toHaveBeenCalledWith('tpex fallback skip cap');
});
it.each([undefined, ''])('skips without a token (%j), without writing a cap', async secret => {
  const fetch = mockFetch(), put = vi.spyOn(bindings.SNAPSHOTS, 'put');
  await run(undefined, undefined, { ...bindings, GH_DISPATCH_TOKEN: secret });
  expect(dispatches(fetch)).toHaveLength(0);
  expect(put).not.toHaveBeenCalled();
  expect(await bindings.SNAPSHOTS.get(capKey)).toBeNull();
  expect(logs.log).toHaveBeenCalledWith('tpex fallback skip no token');
});
it.each(['throw', '500', 'non-error'] as const)('contains dispatch failure %s and keeps TWSE running', async failure => {
  const response = new Response(token, { status: 500 });
  const cancel = vi.spyOn(response.body!, 'cancel');
  const text = vi.spyOn(response, 'text'), json = vi.spyOn(response, 'json');
  const fetch = mockFetch(async () => {
    if (failure === 'throw') throw new TypeError(token);
    if (failure === 'non-error') throw token;
    return response;
  });
  await expect(run()).resolves.toBeUndefined();
  expect(dispatches(fetch)).toHaveLength(1);
  expect(logs.warn).toHaveBeenCalledExactlyOnceWith(failure === '500' ? 'tpex fallback dispatch status=500' : `tpex fallback fail ${failure === 'throw' ? 'TypeError' : 'error'}`);
  expect(logs.log).toHaveBeenCalledWith('stock:twse 304 skip');
  expect(await bindings.SNAPSHOTS.get(capKey)).toBe('1');
  expect(text).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
  if (failure === '500') expect(cancel).toHaveBeenCalledOnce();
  else await response.body?.cancel();
});
it('contains a cap write failure without dispatching or affecting TWSE', async () => {
  const fetch = mockFetch();
  vi.spyOn(bindings.SNAPSHOTS, 'put').mockRejectedValue(new TypeError(token));
  await expect(run()).resolves.toBeUndefined();
  expect(dispatches(fetch)).toHaveLength(0);
  expect(logs.warn).toHaveBeenCalledExactlyOnceWith('tpex fallback fail TypeError');
  expect(logs.log).toHaveBeenCalledWith('stock:twse 304 skip');
});
it.each([
  ['2026-10-30T11:30:00Z', '0,30 * * * MON-FRI'],
  ['2026-10-30T00:00:00Z', '0,30 * * * MON-FRI'],
  ['2026-10-30T11:00:00Z', ''],
  ['2026-10-30T12:30:00Z', ''],
  ['2026-10-30T11:00:00Z', '0 */6 * * SAT,SUN'],
])('does not dispatch at %s with cron %j', async (time, cron) => {
  const fetch = mockFetch();
  await run(time, cron);
  expect(dispatches(fetch)).toHaveLength(0);
  expect(await bindings.SNAPSHOTS.get(capKey)).toBeNull();
});
