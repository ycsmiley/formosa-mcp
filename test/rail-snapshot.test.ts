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
it.each([true, false])('uses yesterday only for an overnight train (Overnight=%s)', async overnight => {
  const snapshot = compactTimetable('TRA', daily('TRA'), date, fetchedAt);
  const stations = compactStations('TRA', fixture('tra-stations'), fetchedAt);
  const yesterday = { ...snapshot, date: '2026-10-28', fetchedAt: '2026-10-27T16:23:00Z', trains: [{ ...snapshot.trains[0], no: '999', overnight, cross: overnight ? '' : '4400', type: '昨日車種' }] };
  const render = () => renderFallback({ train_no: '999' }, 'nokey', snapshot, stations, now, yesterday);
  expect(await render()).toContain('999 次｜昨日車種');
  expect(await render()).toContain('2026-10-28 00:23');
  expect(await renderFallback({ train_no: '999' }, 'nokey', null, stations, now, yesterday)).toContain('999 次｜昨日車種');
  snapshot.trains.push({ ...yesterday.trains[0], type: '今日車種' });
  expect(await render()).toContain('999 次｜今日車種');
  snapshot.trains.pop();
  yesterday.trains[0].overnight = false; yesterday.trains[0].cross = '';
  expect(await render()).toContain('查無 999 次');
});
it('merges yesterday’s rolled-over stops into today’s sorted station board', async () => {
  const snapshot = compactTimetable('TRA', daily('TRA'), date, fetchedAt);
  const stations = compactStations('TRA', fixture('tra-stations'), fetchedAt);
  const train = snapshot.trains[0], midnight = new Date('2026-10-29T00:05:00+08:00');
  snapshot.trains = [{ ...train, no: '901', stops: [['1000', '00:10', '00:11', 0], ['4400', '00:12', '00:13', 0]] },
    { ...train, no: '902', stops: [['1000', '23:40', '23:41', 0], ['4400', '00:40', '00:41', 0]] }];
  const yesterday = { ...snapshot, date: '2026-10-28', trains: [
    { ...snapshot.trains[1], no: '903', overnight: true, stops: [['1000', '23:20', '23:21', 0], ['4400', '00:20', '00:21', 0]] as typeof train.stops },
    { ...snapshot.trains[1], no: '904', stops: [['1000', '23:00', '23:01', 0], ['4400', '00:03', '00:04', 0]] as typeof train.stops },
    { ...snapshot.trains[0], no: '905' },
  ] };
  const text = await renderFallback({ station: '高雄' }, 'nokey', snapshot, stations, midnight, yesterday);
  expect(text.match(/^\d+ 次.*$/gm)).toEqual([
    expect.stringContaining('901 次'), expect.stringContaining('903 次'), expect.stringContaining('902 次'),
  ]);
  expect(text).toContain('表訂時間 00:21\n'); expect(text).toContain('表訂時間 00:41（隔日）');
  const origin = await renderFallback({ station: '臺北' }, 'nokey', snapshot, stations, midnight, yesterday);
  expect(origin).not.toContain('903 次');
});
it.each([1, 2])('marks suspended trains and stops (%i), excluding them from station boards', async suspended => {
  const snapshot = compactTimetable('TRA', daily('TRA'), date, fetchedAt);
  const stations = compactStations('TRA', fixture('tra-stations'), fetchedAt), train = snapshot.trains[0];
  snapshot.trains = [
    { ...train, no: '901', suspended, stops: [['1000', '18:59', '19:00', 0], ['4400', '20:00', '20:01', 0]] },
    { ...train, no: '902', suspended: 0, stops: [['1000', '18:59', '19:00', suspended], ['4400', '20:00', '20:01', 0]] },
    { ...train, no: '903', suspended: 0, stops: [['1000', '18:59', '19:00', 0], ['4400', '20:00', '20:01', 0]] },
  ];
  const cancelled = await renderFallback({ train_no: '901' }, 'nokey', snapshot, stations, now);
  expect(cancelled.split('\n').find(line => line.startsWith('臺鐵表訂停靠站'))).toMatch(/（停駛）$/);
  const skipped = await renderFallback({ train_no: '902' }, 'nokey', snapshot, stations, now);
  expect(skipped).toContain('臺北｜表訂時間 到站 18:59／離站 19:00（停駛）');
  expect(skipped).toContain('高雄｜表訂時間 到站 20:00／離站 20:01\n');
  const board = await renderFallback({ station: '臺北' }, 'nokey', snapshot, stations, now);
  expect(board).toContain('903 次'); expect(board).not.toContain('901 次'); expect(board).not.toContain('902 次');
});
it('formats live age and the snapshot timestamp in Taipei', () => {
  expect(liveAge(now.toISOString(), now)).toBe('即時資料剛剛取得');
  expect(liveAge(new Date(now.getTime() - 119999).toISOString(), now)).toBe('即時資料約 1 分鐘前取得');
  expect(snapshotTime(fetchedAt)).toBe('時刻表資料：2026-10-29 00:23（臺北時間）更新');
});
