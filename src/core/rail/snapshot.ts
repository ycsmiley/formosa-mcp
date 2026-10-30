import { list, object, RailError, string, truncatedNote, unavailable } from './client.js';
import { attribution, type LiveArgs } from './service.js';
import { createStations, type Railway } from './stations.js';
import { hhmm, minutes, taipeiNow, updated } from './time.js';

interface Header { v: 1; date: string; fetchedAt: string; truncated: boolean }
export interface StationsSnapshot extends Header { stations: [id: string, zh: string, en: string][] }
export type Stop = [stationId: string, arr: string, dep: string, suspended: number];
export interface CompactTrain {
  no: string; type: string; end: string; suspended: number; extra: number;
  overnight: boolean; cross: string; stops: Stop[];
}
export interface TimetableSnapshot extends Header { trains: CompactTrain[] }
export const stationKey = (railway: Railway) => `rail:stations:${railway}:v1`;
export const timetableKey = (railway: Railway, date: string) => `rail:timetable:${railway}:${date}:v1`;
const flag = (value: unknown) => typeof value === 'number' && [0, 1, 2].includes(value) ? value : 0;
const zh = (value: unknown) => string(object(value).Zh_tw);
const header = (date: string, fetchedAt: string, truncated: boolean): Header => ({ v: 1, date, fetchedAt, truncated });
export function compactStations(railway: Railway, body: unknown, fetchedAt: string): StationsSnapshot {
  const rows = list(railway === 'THSR' ? body : object(body).Stations);
  const stations: StationsSnapshot['stations'] = rows.map(value => {
    const row = object(value);
    return [string(row.StationID), zh(row.StationName), string(object(row.StationName).En)];
  });
  if (!stations.length || stations.some(([id, name]) => !/^[A-Za-z0-9_-]+$/.test(id) || !name)) throw new RailError(unavailable);
  return { ...header(taipeiNow(new Date(fetchedAt)).date, fetchedAt, rows.length === 1000), stations };
}
export function compactTimetable(railway: Railway, body: unknown, date: string, fetchedAt: string, truncated = false): TimetableSnapshot {
  const rows = list(railway === 'THSR' ? body : object(body).TrainTimetables);
  const trains = rows.map(value => {
    const row = object(value), info = object(railway === 'THSR' ? row.DailyTrainInfo : row.TrainInfo);
    const stops: Stop[] = list(row.StopTimes).map(object).sort((a, b) => Number(a.StopSequence) - Number(b.StopSequence)).map(stop =>
      [string(stop.StationID), string(stop.ArrivalTime), string(stop.DepartureTime), flag(stop.SuspendedFlag)]);
    if (!/^\d+$/.test(string(info.TrainNo)) || stops.length < 2 || stops.some(([id, arr, dep]) => !/^[A-Za-z0-9_-]+$/.test(id) || (minutes(arr) === undefined && minutes(dep) === undefined))) throw new RailError(unavailable);
    return { no: string(info.TrainNo), type: zh(info.TrainTypeName), end: zh(info.EndingStationName), suspended: flag(info.SuspendedFlag), extra: flag(info.ExtraTrainFlag), overnight: info.Overnight === true, cross: string(info.OverNightStationID), stops };
  });
  if (!trains.length) throw new RailError(unavailable);
  return { ...header(date, fetchedAt, truncated), trains };
}
export function expandStations(railway: Railway, snapshot: StationsSnapshot): unknown {
  const rows = snapshot.stations.map(([id, zh, en]) => ({ StationID: id, StationName: { Zh_tw: zh, En: en } }));
  return railway === 'THSR' ? rows : { Stations: rows };
}
export function expandTrain(train: CompactTrain) {
  return {
    info: { TrainNo: train.no, TrainTypeName: { Zh_tw: train.type }, EndingStationName: { Zh_tw: train.end }, SuspendedFlag: train.suspended, ExtraTrainFlag: train.extra, Overnight: train.overnight, OverNightStationID: train.cross },
    stops: train.stops.map(([id, arr, dep, suspended]) => ({ StationID: id, ArrivalTime: arr, DepartureTime: dep, SuspendedFlag: suspended })),
  };
}
export function deriveOD(railway: Railway, snapshot: TimetableSnapshot, origin: string, destination: string): unknown {
  const rows = snapshot.trains.flatMap(train => {
    const from = train.stops.findIndex(s => s[0] === origin), to = train.stops.findIndex(s => s[0] === destination);
    if (from < 0 || to <= from) return [];
    const { info, stops } = expandTrain(train);
    return [railway === 'THSR' ? { DailyTrainInfo: info, OriginStopTime: stops[from], DestinationStopTime: stops[to] } : { TrainInfo: info, StopTimes: stops }];
  });
  return railway === 'THSR' ? rows : { TrainTimetables: rows };
}
export function snapshotTime(fetchedAt?: string) {
  if (!fetchedAt) return '時刻表資料：更新時間未提供';
  return `時刻表資料：${updated(fetchedAt).replace('（臺北時間）', '')}（臺北時間）更新`;
}
export function liveAge(fetchedAt: string, now: Date) {
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(fetchedAt)) / 60_000));
  return age < 1 ? '即時資料剛剛取得' : `即時資料約 ${age} 分鐘前取得`;
}
export const fallbackReasons: Record<string, string> = {
  minute: '目前查詢人數較多（每分鐘上限）', daily: '今日即時查詢額度已用完', monthly: '本月即時查詢額度已用完',
  ip: '你的即時查詢太頻繁', nokey: '伺服器尚未設定 TDX 金鑰', upstream: 'TDX 即時服務暫時無法使用', auth: 'TDX 即時服務暫時無法使用',
};
export async function renderFallback(args: LiveArgs, reason: string, snapshot: TimetableSnapshot | null, stations: StationsSnapshot | null, now: Date, yesterday: TimetableSnapshot | null = null) {
  const lines = [fallbackReasons[reason] ?? fallbackReasons.upstream, '即時誤點暫時無法提供，可帶自己的 TDX 金鑰查即時資料'];
  let source = snapshot ?? yesterday;
  try {
    if (!source || !stations) lines.push('時刻表資料尚未準備好，請稍後再試');
    else {
      const stationName = (id: string) => stations.stations.find(s => s[0] === id)?.[1] ?? id;
      if (args.train_no !== undefined) {
        const no = args.train_no.normalize('NFKC').trim();
        let train = snapshot?.trains.find(t => t.no === no);
        if (!train) {
          train = yesterday?.trains.find(t => t.no === no && (t.overnight || t.cross));
          if (train) source = yesterday;
        }
        if (!train) lines.push(`時刻表中查無 ${no} 次列車`);
        else lines.push(`臺鐵表訂停靠站｜${no} 次｜${train.type || '車種未提供'}｜往 ${train.end || '未提供'}${train.suspended !== 0 ? '（停駛）' : ''}`,
          ...train.stops.map(([id, arr, dep, suspended]) => `${stationName(id)}｜表訂時間 到站 ${arr || '未提供'}／離站 ${dep || '未提供'}${suspended !== 0 ? '（停駛）' : ''}`));
      } else {
        const station = await createStations(async () => expandStations('TRA', stations), () => now)('TRA', args.station ?? '');
        const rows = [snapshot, yesterday].flatMap((day, index) => day?.trains.flatMap(train => {
          const stop = train.stops.find(s => s[0] === station.id);
          if (!stop || train.suspended !== 0 || stop[3] !== 0) return [];
          const time = minutes(stop[2]) ?? minutes(stop[1]);
          // Full-route stop order preserves the operating day's midnight rollover.
          let offset = 0, previous = -1;
          for (const item of train.stops) {
            const t = minutes(item[2]) ?? minutes(item[1]);
            if (t === undefined) continue;
            if (t < previous) offset += 1440;
            previous = t;
            if (item === stop) break;
          }
          if (index === 1 && offset < 1440) return [];
          return time === undefined || time + offset - index * 1440 < taipeiNow(now).minutes ? [] : [{ train, time: time + offset - index * 1440 }];
        }) ?? []).sort((a, b) => a.time - b.time || a.train.no.localeCompare(b.train.no, 'en', { numeric: true }));
        lines.push(`臺鐵表訂看板｜${station.name}`, ...rows.slice(0, 10).map(({ train, time }) => `${train.no} 次｜${train.type || '車種未提供'}｜往 ${train.end || '未提供'}｜表訂時間 ${hhmm(time)}${time >= 1440 ? '（隔日）' : ''}`));
        if (!rows.length) lines.push('時刻表中查無此站接下來的班次');
      }
      if (source?.truncated || (args.train_no === undefined && yesterday?.truncated)) lines.push(truncatedNote);
    }
  } catch { lines.push('時刻表中查無此車站'); }
  return [...lines, snapshotTime(source?.fetchedAt), attribution].join('\n');
}
