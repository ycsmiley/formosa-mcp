import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import cpc from './fixtures/fuel/cpc-mainprodlistprice-2026-11-16.json';
import { main, publishFuel } from '../scripts/publish-fuel.js';
import { directoryStore } from '../scripts/snapshot-store.js';
import { parseFuel } from '../src/core/fuel/parse.js';
import { fuelKey } from '../src/core/fuel/model.js';
import { buildCollector } from '../scripts/build-collectors.mjs';
const time = '2026-11-15T17:17:00.000Z', now = () => new Date(time), changedAt = '2026-11-01T17:17:00.000Z';
const snapshot = (hours: number) => ({ v: 1, items: parseFuel(cpc), changedAt, checkedAt: new Date(Date.parse(time) - hours * 3600000).toISOString() });
function setup(previous: unknown = null) {
  const store = { get: vi.fn(async () => previous === null ? null : JSON.stringify(previous)), put: vi.fn(async () => {}) };
  return { store, fetchFuel: vi.fn(async () => cpc), sleep: vi.fn(async () => {}), now };
}
afterEach(() => vi.restoreAllMocks());
it('writes one changed snapshot with both timestamps and no more than one put', async () => {
  const o = setup(), r = await publishFuel(o); expect(r.writes).toBe(1); expect(r.decision).toBe('changed');
  expect(o.store.put).toHaveBeenCalledExactlyOnceWith(fuelKey, JSON.stringify(r.payload), time); expect(r.payload.changedAt).toBe(time); expect(r.payload.checkedAt).toBe(time);
  const changed = setup(snapshot(1)); changed.fetchFuel.mockResolvedValue(cpc.map((r, i) => i ? r : { ...r, 參考牌價_金額: 35 }));
  expect((await publishFuel(changed)).decision).toBe('changed'); expect(changed.store.put).toHaveBeenCalledTimes(1);
});
it.each([0, 6, 19.999])('skips unchanged content checked %sh ago', async age => {
  const o = setup(snapshot(age)), r = await publishFuel(o); expect(r.writes).toBe(0); expect(r.decision).toBe('skip'); expect(o.store.put).not.toHaveBeenCalled();
});
it.each([20, 24, 48])('heartbeats unchanged content checked %sh ago, preserving changedAt', async age => {
  const o = setup(snapshot(age)), r = await publishFuel(o); expect(r.writes).toBe(1); expect(r.decision).toBe('heartbeat'); expect(r.payload.changedAt).toBe(changedAt); expect(r.payload.checkedAt).toBe(time); expect(o.store.put).toHaveBeenCalledTimes(1);
});
it.each([undefined, 'bad'])('repairs missing/invalid checkedAt with a heartbeat (%s)', async checkedAt => {
  const o = setup({ ...snapshot(1), checkedAt }), r = await publishFuel(o); expect(r.decision).toBe('heartbeat'); expect(r.payload.changedAt).toBe(changedAt); expect(o.store.put).toHaveBeenCalledTimes(1);
});
it('retries fetch three times at 1s/2s and reports redacted failure with zero writes, exit 1', async () => {
  const o = setup(); o.fetchFuel.mockRejectedValue(Error('token-private https://example.invalid/?token=token-private'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await main(['--out', '/tmp/unused-fuel'], { CLOUDFLARE_KV_WRITE_TOKEN: 'token-private' }, o);
  expect(code).toBe(1); expect(o.fetchFuel).toHaveBeenCalledTimes(3); expect(o.sleep.mock.calls).toEqual([[1000], [2000]]); expect(o.store.get).not.toHaveBeenCalled(); expect(o.store.put).not.toHaveBeenCalled();
  expect(warn.mock.calls.flat().join()).toContain('::warning::'); expect(warn.mock.calls.flat().join()).not.toMatch(/token-private|https?:/); expect(log).toHaveBeenCalledWith('fuel KV writes=0');
});
it('recovers on a subsequent fetch and rejects bad upstream without writing', async () => {
  const o = setup(); o.fetchFuel.mockRejectedValueOnce(Error('offline')); expect((await publishFuel(o)).writes).toBe(1); expect(o.sleep).toHaveBeenCalledWith(1000);
  const invalid = setup(); invalid.fetchFuel.mockResolvedValue([]); await expect(publishFuel(invalid)).rejects.toThrow(/中油/); expect(invalid.store.put).not.toHaveBeenCalled();
});
it.each([null, snapshot(20), snapshot(1)])('dry-run prints exact proposed JSON and never calls put (%#)', async old => {
  const o = setup(old), output: string[] = [], r = await publishFuel({ ...o, dryRun: true, log: s => output.push(s) });
  expect(o.store.put).not.toHaveBeenCalled(); expect(r.writes).toBe(0); expect(output[0]).toBe(old === null ? 'would write (changed)' : r.decision === 'skip' ? 'skip' : 'would write (heartbeat)'); expect(JSON.parse(output[1])).toEqual(r.payload);
});
it('requires configuration before networking and dry-run needs no credentials or KV reads', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {}), log = vi.spyOn(console, 'log').mockImplementation(() => {}), o = setup();
  expect(await main([], {}, o)).toBe(2); expect(error).toHaveBeenCalledWith('fuel KV configuration missing'); expect(o.fetchFuel).not.toHaveBeenCalled();
  const fetchFuel = vi.fn(async () => cpc);
  expect(await main(['--dry-run'], {}, { fetchFuel, now })).toBe(0); expect(log).toHaveBeenCalledWith('would write (changed)'); expect(log).toHaveBeenCalledWith('fuel KV writes=0');
});
it('directory dry-run reads the existing snapshot without changing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fuel-dry-')), store = directoryStore(dir), old = JSON.stringify(snapshot(1));
  try {
    await store.put(fuelKey, old, time); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--dry-run', '--out', dir], {}, { fetchFuel: async () => cpc, now })).toBe(0); expect(log).toHaveBeenCalledWith('skip'); expect(await store.get(fuelKey)).toBe(old);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('committed fuel publisher bundle equals a fresh build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fuel-bundle-'));
  try { const output = join(dir, 'publish-fuel.mjs'); await buildCollector('fuel', output); expect((await readFile(output)).equals(await readFile('scripts/dist/publish-fuel.mjs'))).toBe(true); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
it('keeps the fuel workflow pinned, read-only, on existing credentials and committed bundle', async () => {
  const workflow = await readFile('.github/workflows/fuel-collect.yml', 'utf8');
  for (const text of ["cron: '17 17,23 * * *'", '# 01:17, 07:17 Taipei', 'workflow_dispatch:', 'timeout-minutes: 3', 'group: fuel-collect', 'persist-credentials: false', 'node-version: 22', 'KV_NAMESPACE_ID: e92149e1efec4434835310d434b69f7d', 'vars.CLOUDFLARE_ACCOUNT_ID', 'node scripts/dist/publish-fuel.mjs']) expect(workflow).toContain(text);
  expect(workflow).toMatch(/permissions:\n  contents: read/); expect([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1])).toEqual(['CLOUDFLARE_KV_WRITE_TOKEN']);
  expect(workflow).toMatch(/- run: node scripts\/dist\/publish-fuel.mjs\n        env:\n          CLOUDFLARE_KV_WRITE_TOKEN:/);
  for (const m of workflow.matchAll(/uses:\s*(\S+)/g)) expect(m[1]).toMatch(/@[a-f0-9]{40}$/); expect(workflow).not.toContain('npm');
});
