import { readFileSync } from 'node:fs';
import { expect, it, vi, afterEach, beforeEach } from 'vitest';
import { createRailService } from '../src/core/rail/service.js';
import { compactStations, compactTimetable, deriveOD, expandStations, liveAge, renderFallback, snapshotTime, fallbackReasons } from '../src/core/rail/snapshot.js';
import type { Railway } from '../src/core/rail/stations.js';
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/tdx/real/${file}.json`, import.meta.url), 'utf8'));
const fetchedAt = '2026-10-28T16:23:00.000Z', date = '2026-10-29';
const now = new Date('2026-10-29T18:18:00+08:00');
// Synthetic TrainDate shape built from captured OD rows, retaining their stop order.
const daily = (railway: Railway) => railway === 'TRA' ? fixture('tra-od-1000-4400') : fixture('thsr-od-1000-1070').map((row: any) => ({ DailyTrainInfo: row.DailyTrainInfo, StopTimes: [row.OriginStopTime, row.DestinationStopTime] }));
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline only')); });
afterEach(() => vi.restoreAllMocks());
it.each(['THSR', 'TRA'] as const)('%s compact snapshots render exactly the captured OD rows', async railway => {
  const stations = compactStations(railway, fixture(railway === 'THSR' ? 'thsr-stations' : 'tra-stations'), fetchedAt);
  const snapshot = compactTimetable(railway, daily(railway), date, fetchedAt);
  const od = fixture(railway === 'THSR' ? 'thsr-od-1000-1070' : 'tra-od-1000-4400');
  const render = async (body: unknown, stationBody: unknown) => createRailService({ clock: () => now, get: async path => path.endsWith('/Station') ? stationBody : body }).timetable(railway, { origin: '臺北', destination: railway === 'THSR' ? '左營' : '高雄', date });
  expect(await render(deriveOD(railway, snapshot, '1000', railway === 'THSR' ? '1070' : '4400'), expandStations(railway, stations))).toEqual(await render(od, fixture(railway === 'THSR' ? 'thsr-stations' : 'tra-stations')));
  const serialized = JSON.stringify(snapshot);
  expect(serialized.length).toBeLessThan(JSON.stringify(daily(railway)).length / 2);
  expect(serialized).not.toMatch(/Direction|StopSequence|StationName|VersionID|TrainTypeID/);
  expect(deriveOD(railway, snapshot, '4400', '1000')).toEqual(railway === 'THSR' ? [] : { TrainTimetables: [] });
});
it('preserves flags, midnight information and stop ordering', () => {
  const snapshot = compactTimetable('TRA', { TrainTimetables: [{ TrainInfo: { TrainNo: '001', TrainTypeName: { Zh_tw: '區間' }, EndingStationName: { Zh_tw: '高雄' }, SuspendedFlag: 2, ExtraTrainFlag: 1, OverNightStationID: '1000' }, StopTimes: [{ StationID: '4400', ArrivalTime: '00:20', DepartureTime: '00:21', StopSequence: 2, SuspendedFlag: 1 }, { StationID: '1000', ArrivalTime: '23:00', DepartureTime: '23:01', StopSequence: 1 }] }] }, date, fetchedAt, true);
  expect(snapshot.trains[0]).toMatchObject({ no: '001', cross: '1000', suspended: 2, extra: 1, end: '高雄', stops: [['1000', '23:00', '23:01', 0], ['4400', '00:20', '00:21', 1]] });
  expect(snapshot.truncated).toBe(true);
});
it.each([[], {}, { TrainTimetables: [] }, { TrainTimetables: [{ TrainInfo: {}, StopTimes: [] }] }])('rejects empty or invalid timetables %j', body => {
  expect(() => compactTimetable('TRA', body, date, fetchedAt)).toThrow();
});
it('rejects invalid stations', () => {
  for (const body of [[], [{}], [{ StationID: '1000' }]]) expect(() => compactStations('THSR', body, fetchedAt)).toThrow();
});
it.each(Object.keys(fallbackReasons))('renders scheduled train fallback for %s with attribution and age', async reason => {
  const snapshot = compactTimetable('TRA', daily('TRA'), date, fetchedAt);
  const stations = compactStations('TRA', fixture('tra-stations'), fetchedAt);
  const text = await renderFallback({ train_no: '149' }, reason, snapshot, stations, now);
  expect(text).toContain(fallbackReasons[reason]);
  expect(text).toContain('149 次'); expect(text).toContain('臺北｜表訂時間');
  expect(text).toContain('即時誤點暫時無法提供，可帶自己的 TDX 金鑰查即時資料');
  expect(text).toContain('時刻表資料：2026-10-29 00:23（臺北時間）更新');
  expect(text).toContain('資料介接「交通部TDX平臺」');
  expect(text).not.toMatch(/\{|undefined|NaN/);
});
it('renders at most ten station departures from now with destinations and handles missing rows', async () => {
  const snapshot = compactTimetable('TRA', daily('TRA'), date, fetchedAt);
  const stations = compactStations('TRA', fixture('tra-stations'), fetchedAt);
  const text = await renderFallback({ station: '台北' }, 'daily', snapshot, stations, now);
  expect(text).toContain('臺鐵表訂看板｜臺北'); expect(text).toContain('往 '); expect(text).toContain('表訂時間 18:59');
  expect(text).not.toContain('表訂時間 06:27');
  expect([...text.matchAll(/^\d+ 次/gm)].length).toBeLessThanOrEqual(10);
  expect(await renderFallback({ train_no: '99999' }, 'monthly', snapshot, stations, now)).toContain('查無 99999 次');
  expect(await renderFallback({ station: '不存在' }, 'ip', snapshot, stations, now)).toContain('查無此車站');
  expect(await renderFallback({ station: '臺北' }, 'nokey', null, null, now)).toContain('時刻表資料尚未準備好');
});
it('formats live age and the snapshot timestamp in Taipei', () => {
  expect(liveAge(now.toISOString(), now)).toBe('即時資料剛剛取得');
  expect(liveAge(new Date(now.getTime() - 119999).toISOString(), now)).toBe('即時資料約 1 分鐘前取得');
  expect(snapshotTime(fetchedAt)).toBe('時刻表資料：2026-10-29 00:23（臺北時間）更新');
});
