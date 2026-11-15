import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RAIL_TIMETABLE_STALE_MS } from '../src/core/freshness.js';
import { stationKey, timetableKey, type StationsSnapshot, type TimetableSnapshot } from '../src/core/rail/snapshot.js';
import { workerRail, type RailEnv } from '../src/worker/rail.js';

const date = '2026-10-29', previousDate = '2026-10-28';
const healthyFetch = '2026-10-28T00:23:00+08:00';
const train: TimetableSnapshot['trains'][number] = {
  no: '901', type: '區間', end: '高雄', suspended: 0, extra: 0, overnight: false, cross: '',
  stops: [['1000', '23:49', '23:50', 0], ['4400', '23:59', '23:59', 0]],
};
const timetable = (day = date, fetchedAt = healthyFetch, trains = [train]): TimetableSnapshot => ({ v: 1, date: day, fetchedAt, truncated: false, trains });
function service(today = timetable(), yesterday = timetable(previousDate, '2026-10-27T00:23:00+08:00')) {
  const stations: StationsSnapshot = { v: 1, date, fetchedAt: healthyFetch, truncated: false, stations: [['1000', '臺北', 'Taipei'], ['4400', '高雄', 'Kaohsiung']] };
  const values = new Map<string, string>();
  for (const railway of ['THSR', 'TRA'] as const) {
    values.set(stationKey(railway), JSON.stringify(stations));
    values.set(timetableKey(railway, today.date), JSON.stringify(today));
    values.set(timetableKey(railway, yesterday.date), JSON.stringify(yesterday));
  }
  return workerRail({ SNAPSHOTS: { get: async (key: string) => values.get(key) ?? null } } as unknown as RailEnv, 'ip', undefined);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${date}T23:49:00+08:00`));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('snapshot reads must not fetch'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.restoreAllMocks();
});

it.each(['THSR', 'TRA', 'train'] as const)('%s uses the same operating-date freshness boundary', async mode => {
  for (const offset of [-1, 0, 1]) {
    const fetchedAt = new Date(Date.parse(`${date}T00:00:00+08:00`) - RAIL_TIMETABLE_STALE_MS - offset).toISOString();
    const rail = service(timetable(date, fetchedAt));
    const result = mode === 'train' ? await rail.live({ train_no: '901' })
      : await rail.timetable(mode, { origin: '1000', destination: '4400', time: '00:00' });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain('901 次');
    expect(result.text.includes('可能不是最新')).toBe(offset > 0);
  }
});

it.each(['00:23', '04:23'])('keeps a healthy evening station board fresh after the %s collection', async time => {
  const result = await service(timetable(date, `2026-10-28T${time}:00+08:00`), timetable(previousDate, `2026-10-27T${time}:00+08:00`)).live({ station: '臺北' });
  expect(result.text).toContain('901 次');
  expect(result.text).not.toContain('可能不是最新');
});

it.each([true, false])('checks consulted yesterday freshness when today’s train is selected (stale=%s)', async stale => {
  const yesterday = timetable(previousDate, stale ? '2026-10-25T23:59:59.999+08:00' : '2026-10-27T00:23:00+08:00');
  const today = timetable(date, healthyFetch, [{ ...train, type: '今日車種' }]);
  const result = await service(today, yesterday).live({ train_no: '901' });
  expect(result.isError).not.toBe(true);
  expect(result.text).toContain('901 次｜今日車種');
  expect(result.text).toContain('時刻表資料：2026-10-28 00:23（臺北時間）更新');
  expect(result.text.includes('可能不是最新')).toBe(stale);
  if (stale) expect(result.text).toContain('最後更新：2026-10-25 23:59（臺北時間）；表訂時刻表');
});

it('uses yesterday’s operating-date boundary for a selected overnight train', async () => {
  vi.setSystemTime(new Date(`${date}T00:05:00+08:00`));
  for (const offset of [-1, 0, 1]) {
    const fetchedAt = new Date(Date.parse(`${previousDate}T00:00:00+08:00`) - RAIL_TIMETABLE_STALE_MS - offset).toISOString();
    const yesterday = timetable(previousDate, fetchedAt, [{ ...train, no: '903', overnight: true, stops: [
      ['1000', '23:00', '23:01', 0], ['4400', '00:20', '00:21', 0],
    ] }]);
    const result = await service(timetable(), yesterday).live({ train_no: '903' });
    expect(result.text).toContain('903 次');
    expect(result.text.includes('可能不是最新')).toBe(offset > 0);
  }
});

it.each(['filtered out', 'outside first ten'] as const)('warns when stale today contributes no displayed rows: %s', async placement => {
  vi.setSystemTime(new Date(`${date}T00:05:00+08:00`));
  const today = timetable(date, '2026-10-26T23:59:59.999+08:00', [{ ...train, stops: [
    ['1000', '00:00', '00:00', 0], ['4400', '00:00', placement === 'filtered out' ? '00:01' : '00:30', 0],
  ] }]);
  const yesterday = timetable(previousDate, '2026-10-27T00:23:00+08:00', Array.from({ length: 10 }, (_, i) => ({
    ...train, no: String(910 + i), overnight: true, stops: [
      ['1000', '23:00', '23:01', 0], ['4400', '00:20', '00:21', 0],
    ] as typeof train.stops,
  })));
  const result = await service(today, yesterday).live({ station: '高雄' });
  expect(result.text.match(/^\d+ 次/gm)).toHaveLength(10);
  expect(result.text).not.toContain('901 次');
  expect(result.text).toContain('最後更新：2026-10-26 23:59（臺北時間）；表訂時刻表');
});

it.each(['filtered out', 'outside first ten'] as const)('warns when stale yesterday contributes no displayed rows: %s', async placement => {
  vi.setSystemTime(new Date(`${date}T00:05:00+08:00`));
  const today = timetable(date, healthyFetch, Array.from({ length: 10 }, (_, i) => ({
    ...train, no: String(910 + i), stops: [['1000', '00:10', '00:11', 0], ['4400', '00:20', '00:21', 0]] as typeof train.stops,
  })));
  const yesterday = timetable(previousDate, '2026-10-25T23:59:59.999+08:00', [{ ...train, overnight: true, stops: [
    ['1000', '23:00', '23:01', 0], ['4400', '00:00', placement === 'filtered out' ? '00:01' : '00:30', 0],
  ] }]);
  const result = await service(today, yesterday).live({ station: '高雄' });
  expect(result.text.match(/^\d+ 次/gm)).toHaveLength(10);
  expect(result.text).not.toContain('901 次');
  expect(result.text).toContain('最後更新：2026-10-25 23:59（臺北時間）；表訂時刻表');
});
