import { afterEach, describe, expect, it, vi } from 'vitest';
import cpc from './fixtures/fuel/cpc-mainprodlistprice-2026-11-16.json';
import { parseFuel } from '../src/core/fuel/parse.js';
import { decodeFuel } from '../src/core/fuel/model.js';
import { formatFuel } from '../src/core/fuel/format.js';
import { createFuelService } from '../src/core/fuel/service.js';
import { fetchFuel, fuelUrl } from '../src/core/fuel/source.js';
import { fuelWarning, FUEL_ADJUST_BUFFER_MS } from '../src/core/freshness.js';
const time = '2026-11-15T17:17:00.000Z', snapshot = () => ({ v: 1 as const, items: parseFuel(cpc), changedAt: time, checkedAt: time });
afterEach(() => { vi.restoreAllMocks(); });
it('normalizes all 13 CPC rows including ROC dates, trimmed customers and industrial units', () => {
  const items = parseFuel(cpc);
  expect(items).toHaveLength(13); expect(items.filter(i => i.category === '汽柴油零售')).toHaveLength(7);
  expect(items[1]).toEqual({ category: '汽柴油零售', product: '95無鉛汽油', customer: '一般自用客戶', place: '中油自營站', unit: '元/公升', price: 32.7, effective: '2026-11-16' });
  expect(items[7].effective).toBe('2026-11-06'); expect(items[7].unit).toBe('元/公秉');
});
it.each([null, {}, [], cpc.slice(0, 3), [...cpc, null], cpc.map((r, i) => i ? r : { ...r, 參考牌價_金額: 0 }), cpc.map((r, i) => i ? r : { ...r, 參考牌價_金額: Infinity }), cpc.map((r, i) => i ? r : { ...r, 參考牌價_金額: '34.7' }), cpc.map((r, i) => i ? r : { ...r, 牌價生效日期: '1150230' }), cpc.map((r, i) => i ? r : { ...r, 牌價生效日期: '0001116' }), cpc.map((r, i) => i ? r : { ...r, 產品名稱: ' ' })])('rejects incomplete or invalid upstream data (%#)', value => {
  expect(() => parseFuel(value)).toThrow(/中油牌價資料/);
});
it('strictly decodes snapshots and rejects unknown keys, bad times/dates/items and versions', () => {
  const s = snapshot(); expect(decodeFuel(JSON.stringify(s))).toEqual(s);
  for (const raw of ['bad', null, [], { ...s, v: 2 }, { ...s, extra: 1 }, { ...s, checkedAt: undefined }, { ...s, checkedAt: '2026-02-30T00:00:00.000Z' }, { ...s, changedAt: 'bad' }, { ...s, items: [{ ...s.items[0], effective: '2026-02-30' }] }, { ...s, items: s.items.map(i => ({ ...i, raw: true })) }]) expect(decodeFuel(raw)).toBeNull();
});
it('defaults to retail, filters all rows, retains units and lists products on no match', () => {
  const s = snapshot(), now = new Date(time), text = formatFuel(s, undefined, now);
  expect(text).toContain('95無鉛汽油：32.7 元/公升'); expect(text).not.toContain('特種低硫燃料油');
  expect(text).toContain('牌價生效日：2026-11-16（星期一）'); expect(text.match(/牌價生效日/g)).toHaveLength(1);
  expect(text).toContain('2026-11-16 01:17（臺北時間，最後確認）');
  expect(formatFuel(s, '95', now)).not.toContain('98無鉛');
  expect(formatFuel(s, '燃料油', now)).toContain('27937 元/公秉');
  expect(formatFuel(s, '柴油', now)).toContain('海運輕柴油'); expect(formatFuel(s, '柴油', now)).not.toContain('95無鉛汽油');
  const none = formatFuel(s, '台塑', now); expect(none).toContain('找不到'); expect(none).toContain('可查詢產品：98無鉛汽油'); expect(none).toContain('不含台塑石化'); expect(none).toContain(fuelUrl);
});
it('prints dates per row when effective dates differ', () => {
  const s = snapshot(); s.items[0].effective = '2026-11-09';
  const text = formatFuel(s, undefined, new Date(time));
  expect(text).toContain('98無鉛汽油：34.7 元/公升｜牌價生效日：2026-11-09（星期一）');
  expect(text).toContain('95無鉛汽油：32.7 元/公升｜牌價生效日：2026-11-16'); expect(text).not.toMatch(/^牌價生效日/m);
});
describe('weekly freshness uses successful checks, never price effective date', () => {
  const boundary = Date.parse('2026-11-16T00:00:00+08:00'), before = new Date(boundary - 1).toISOString();
  it('is fresh at Monday boundary +25h equality and stale one millisecond later', () => {
    expect(fuelWarning(before, new Date(boundary + FUEL_ADJUST_BUFFER_MS))).toBe('');
    expect(fuelWarning(before, new Date(boundary + FUEL_ADJUST_BUFFER_MS + 1))).toMatch(/可能不是最新.*中油牌價/);
  });
  it('is fresh for checks at or after the Monday boundary and warns for missing/invalid checks', () => {
    const now = new Date(boundary + 5 * 86400000);
    for (const at of [boundary, boundary + 1]) expect(fuelWarning(new Date(at).toISOString(), now)).toBe('');
    for (const at of [undefined, '', 'invalid', '2026-02-30T00:00:00.000Z']) expect(fuelWarning(at, now)).toMatch(/可能不是最新/);
    const s = snapshot(); s.items = s.items.map(i => ({ ...i, effective: '2025-01-01' })); expect(formatFuel(s, undefined, now)).not.toMatch(/可能不是最新/);
  });
});
it('fetches the lowercase URL with redirect-follow and a 15s timeout', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(cpc));
  expect(await fetchFuel()).toEqual(cpc); expect(fetch).toHaveBeenCalledWith(fuelUrl, { redirect: 'follow', signal: expect.any(AbortSignal) });
});
it('caches successes for an hour using fetch time and never caches failures', async () => {
  let now = new Date(time); const load = vi.fn().mockRejectedValueOnce(Error('private https://secret/')).mockResolvedValue(cpc);
  const service = createFuelService({ fetchFuel: load, clock: () => now });
  const failed = await service.query(); expect(failed.isError).toBe(true); expect(failed.text).toContain('無法取得中油牌價'); expect(failed.text).toContain(fuelUrl); expect(failed.text).not.toContain('secret');
  expect((await service.query()).isError).toBeUndefined(); now = new Date(now.getTime() + 3599999);
  expect((await service.query('95')).text).toContain('01:17'); expect(load).toHaveBeenCalledTimes(2);
  now = new Date(now.getTime() + 1); await service.query(); expect(load).toHaveBeenCalledTimes(3);
});
