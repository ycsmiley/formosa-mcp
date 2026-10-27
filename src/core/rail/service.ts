import type { Clock } from '../clock.js';
import { createTdxClient, list, object, RailError, railRowLimit, string, truncatedNote, unavailable, type RailCredentials, type RailHttp } from './client.js';
import { createStations, type Railway } from './stations.js';
import { hhmm, minutes, operatingHHmm, operatingTimes, parseDate, parseTime, updated } from './time.js';

export const attribution = '資料介接「交通部TDX平臺」';
export interface RailResult { text: string; isError?: boolean }
export interface TimetableArgs { origin: string; destination: string; date?: string; time?: string }
export interface LiveArgs { train_no?: string; station?: string }
export interface RailServiceOptions { credentials: RailCredentials; http: RailHttp; clock?: Clock }
const name = (value: unknown, fallback = '未提供') => string(object(value).Zh_tw) || fallback;
const trainNo = (value: unknown) => { const s = string(value); if (!/^\d+$/.test(s)) throw new RailError(unavailable); return s; };
function delay(value: unknown, status: unknown) {
  if (status === 2) return '取消';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '誤點資料未提供';
  return value === 0 ? '準點' : `晚 ${value} 分`;
}
const incompleteNote = '部分班次資料不完整';
const duration = (m: number) => `${Math.floor(m / 60) ? `${Math.floor(m / 60)} 小時 ` : ''}${m % 60} 分`;
const showTime = (m: number) => `${hhmm(m)}${m >= 1440 ? '（隔日）' : ''}`;
export function createRailService(options: RailServiceOptions) {
  const clock = options.clock ?? (() => new Date());
  const client = createTdxClient(options.credentials, options.http, clock);
  const resolve = createStations(client.get, clock);
  async function run(action: () => Promise<string>): Promise<RailResult> {
    try { return { text: `${await action()}\n${attribution}` }; }
    catch (error) { return { text: error instanceof RailError ? error.message : unavailable, isError: true }; }
  }
  return {
    timetable(railway: Railway, args: TimetableArgs) { return run(async () => {
      const now = clock(), date = parseDate(args.date, now), after = parseTime(args.time, date, now);
      const [origin, destination] = await Promise.all([resolve(railway, args.origin), resolve(railway, args.destination)]);
      if (origin.id === destination.id) throw new RailError('起站與迄站不可相同');
      const route = railway === 'THSR' ? '/v2/Rail/THSR/DailyTimetable' : '/v3/Rail/TRA/DailyTrainTimetable';
      const body = await client.get(`${route}/OD/${encodeURIComponent(origin.id)}/to/${encodeURIComponent(destination.id)}/${date}`);
      const source = list(railway === 'THSR' ? body : object(body).TrainTimetables);
      let skipped = 0;
      const rows = source.flatMap(value => {
        try {
        const row = object(value), info = object(railway === 'THSR' ? row.DailyTrainInfo : row.TrainInfo);
        const stops = railway === 'THSR' ? [] : list(row.StopTimes).map(object);
        const from = railway === 'THSR' ? object(row.OriginStopTime) : stops.find(s => s.StationID === origin.id);
        const to = railway === 'THSR' ? object(row.DestinationStopTime) : stops.find(s => s.StationID === destination.id);
        if (!from || !to || from.StationID !== origin.id || to.StationID !== destination.id) throw new RailError(unavailable);
        const dep = minutes(from.DepartureTime), arr = minutes(to.ArrivalTime);
        if (dep === undefined || arr === undefined) throw new RailError(unavailable);
        const crossId = string(info.OverNightStationID);
        const crossing = crossId === origin.id ? 'origin' : crossId === destination.id ? 'destination' : undefined;
        const times = operatingTimes(dep, arr, info.Overnight === true || !!crossId, crossing);
        const suspended = info.SuspendedFlag === 1 ? '停駛' : info.SuspendedFlag === 2 || from.SuspendedFlag === 1 || to.SuspendedFlag === 1 ? '部分停駛' : '';
        return [{ ...times, no: trainNo(info.TrainNo), type: railway === 'TRA' ? name(info.TrainTypeName, '車種未提供') : '高鐵',
          markers: [suspended, info.ExtraTrainFlag === 1 ? '加班車' : '', times.inferred ? '跨夜日序依時刻推定' : ''].filter(Boolean) }];
        } catch (error) { if (!(error instanceof RailError)) throw error; skipped++; return []; }
      }).filter(row => row.departure >= after).sort((a, b) => a.departure - b.departure || a.no.localeCompare(b.no, 'en', { numeric: true }));
      const lines = [`${railway === 'THSR' ? '高鐵' : '臺鐵'}時刻｜${origin.name} → ${destination.name}｜營運日 ${date}｜${operatingHHmm(after)} 起（臺北時間）`,
        ...new Set([origin.note, destination.note].filter(Boolean)),
        ...rows.slice(0, 10).map(row => `${row.no} 次｜${row.type}｜${showTime(row.departure)} → ${showTime(row.arrival)}｜${duration(row.arrival - row.departure)}${row.markers.length ? `｜${row.markers.join('、')}` : ''}`)];
      if (!rows.length) lines.push(skipped ? '此時段後沒有可顯示的完整班次資料' : '當天此時段後沒有班次');
      if (rows.length > 10) lines.push(`另有 ${rows.length - 10} 班，請指定 time=${operatingHHmm(rows[10].departure)} 查詢`);
      if (origin.truncated || destination.truncated || source.length === railRowLimit) lines.push(truncatedNote);
      if (skipped) lines.push(incompleteNote);
      return lines.join('\n');
    }); },
    live(args: LiveArgs) { return run(async () => {
      if ((args.train_no !== undefined) === (args.station !== undefined)) throw new RailError('請擇一提供 train_no（車次）或 station（車站）');
      if (args.train_no !== undefined) {
        const no = args.train_no.normalize('NFKC').trim();
        if (!/^\d{1,10}$/.test(no)) throw new RailError('請輸入有效的數字車次');
        const data = object(await client.get(`/v3/Rail/TRA/TrainLiveBoard/TrainNo/${encodeURIComponent(no)}`));
        const source = list(data.TrainLiveBoards);
        const rows = source.map(object).filter(row => /^\d+$/.test(string(row.TrainNo)));
        const skipped = rows.length !== source.length;
        if (!rows.length) return [skipped ? '查無可顯示的完整即時資料' : '查無此車次即時資料（可能尚未發車或已抵達）', ...(source.length === railRowLimit ? [truncatedNote] : []), ...(skipped ? [incompleteNote] : [])].join('\n');
        const lines = rows.map(row => `${trainNo(row.TrainNo)} 次｜${name(row.TrainTypeName, '車種未提供')}｜${delay(row.DelayTime, undefined)}\n目前位置：${name(row.StationName)}（${row.TrainStationStatus === 0 ? '進站中' : row.TrainStationStatus === 1 ? '在站上' : row.TrainStationStatus === 2 ? '已離站' : '狀態未提供'}）\n資料更新：${updated(row.UpdateTime ?? data.UpdateTime)}`);
        if (source.length === railRowLimit) lines.push(truncatedNote);
        if (skipped) lines.push(incompleteNote);
        return lines.join('\n');
      }
      const station = await resolve('TRA', args.station!);
      const data = object(await client.get(`/v3/Rail/TRA/StationLiveBoard/Station/${encodeURIComponent(station.id)}`));
      const source = list(data.StationLiveBoards);
      const rows = source.map(object).filter(row => /^\d+$/.test(string(row.TrainNo)));
      const skipped = rows.length !== source.length;
      if (!rows.length) return [`${station.name}｜${skipped ? '查無可顯示的完整即時資料' : '查無車站即時資料'}`, ...(station.truncated || source.length === railRowLimit ? [truncatedNote] : []), ...(skipped ? [incompleteNote] : [])].join('\n');
      return [`臺鐵即時看板｜${station.name}`, ...rows.map(row => {
        const dep = minutes(row.ScheduleDepartureTime), arr = minutes(row.ScheduleArrivalTime);
        const platform = string(row.Platform);
        return `${trainNo(row.TrainNo)} 次｜${name(row.TrainTypeName, '車種未提供')}｜往 ${name(row.EndingStationName)}｜表訂到站 ${arr === undefined ? '未提供' : hhmm(arr)}／離站 ${dep === undefined ? '未提供' : hhmm(dep)}｜${delay(row.DelayTime, row.RunningStatus)}${platform && platform !== '00' ? `｜月台 ${platform}` : ''}\n資料更新：${updated(row.UpdateTime ?? data.UpdateTime)}`;
      }), ...(station.truncated || source.length === railRowLimit ? [truncatedNote] : []), ...(skipped ? [incompleteNote] : [])].join('\n');
    }); },
  };
}
