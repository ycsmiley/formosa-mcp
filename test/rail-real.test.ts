import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRailService, type RailResult } from '../src/core/rail/service.js';
import { createStations } from '../src/core/rail/stations.js';
import type { RailHttp } from '../src/core/rail/client.js';

const clock = () => new Date('2026-10-29T18:18:00+08:00');
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/tdx/real/${file}.json`, import.meta.url), 'utf8'));
const paths: Record<string, string> = {
  '/v2/Rail/THSR/Station': 'thsr-stations',
  '/v2/Rail/THSR/DailyTimetable/OD/1000/to/1070/2026-10-29': 'thsr-od-1000-1070',
  '/v3/Rail/TRA/Station': 'tra-stations',
  '/v3/Rail/TRA/DailyTrainTimetable/OD/1000/to/4400/2026-10-29': 'tra-od-1000-4400',
  '/v3/Rail/TRA/StationLiveBoard/Station/1000': 'tra-station-live-1000',
  '/v3/Rail/TRA/TrainLiveBoard/TrainNo/2037': 'tra-train-live-2037',
};
const realHttp: RailHttp = async url => {
  const parsed = new URL(url);
  if (parsed.pathname === '/auth/realms/TDXConnect/protocol/openid-connect/token') {
    return { status: 200, json: async () => ({ access_token: 'offline-test-token', token_type: 'Bearer', expires_in: 86400 }) };
  }
  expect(parsed.searchParams.get('$top')).toBe('1000');
  expect(parsed.searchParams.get('$format')).toBe('JSON');
  const file = paths[parsed.pathname.replace(/^\/api\/basic/, '')];
  if (!file) throw new Error(`Unexpected offline fixture path: ${parsed.pathname}`);
  return { status: 200, json: async () => fixture(file) };
};
function service(http: RailHttp = realHttp) {
  return createRailService({ credentials: { clientId: 'offline-test-id', clientSecret: 'offline-test-secret' }, http, clock });
}
function success(result: RailResult) {
  expect(result.isError).not.toBe(true);
  expect(result.text.endsWith('資料介接「交通部TDX平臺」')).toBe(true);
  expect(result.text).not.toMatch(/\{|Zh_tw|undefined|null|NaN|\[object/);
  return result.text;
}
const numbers = (text: string) => [...text.matchAll(/^(\d+) 次/gm)].map(m => m[1]);
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in real-fixture rail tests')); });
afterEach(() => { vi.restoreAllMocks(); });

it.each(['臺北', '台北'])('formats captured THSR %s → 左營 with the next departure first and leading zeros intact', async origin => {
  const text = success(await service().timetable('THSR', { origin, destination: '左營' }));
  expect(text).toContain('營運日 2026-10-29｜18:18 起（臺北時間）');
  expect(numbers(text)[0]).toBe('0673');
  expect(text.split('\n').find(line => /^\d+ 次/.test(line))).toBe('0673 次｜高鐵｜18:21 → 20:20｜1 小時 59 分');
  expect(numbers(text)).toEqual(['0673', '0153', '0675', '0249', '0853', '1985', '0295']);
  expect(text).not.toContain('0803 次'); // Captured morning train is filtered by the fixed Taipei clock.
});

it('formats captured TRA midnight crossing within and after the OD pair without inference', async () => {
  const http = vi.fn(realHttp);
  const text = success(await service(http).timetable('TRA', { origin: '臺北', destination: '高雄' }));
  const train149 = text.split('\n').find(line => line.startsWith('149 次'));
  expect(train149).toContain('18:59 → 23:57｜4 小時 58 分');
  expect(train149).not.toContain('（隔日）');
  const train281 = text.split('\n').find(line => line.startsWith('281 次'));
  expect(train281).toContain('19:30 → 00:21（隔日）｜4 小時 51 分');
  expect(text).not.toContain('跨夜日序依時刻推定');
  expect(http.mock.calls.some(([url]) => url.includes('/OD/1000/to/4400/2026-10-29?'))).toBe(true);
  expect(http.mock.calls.some(([url]) => url.includes('/1001/'))).toBe(false);
});

it('resolves captured TRA 臺北 to 1000 alongside the distinct 臺北-環島 station', async () => {
  const data = fixture('tra-stations');
  expect(data.Stations.find((row: { StationID: string }) => row.StationID === '1001').StationName.Zh_tw).toBe('臺北-環島');
  const resolve = createStations(async path => {
    expect(path).toBe('/v3/Rail/TRA/Station');
    return data;
  }, clock);
  expect(await resolve('TRA', '臺北')).toMatchObject({ id: '1000', name: '臺北' });
});

it('sorts captured TRA station departures stably and formats delays and row update time', async () => {
  const text = success(await service().live({ station: '臺北' }));
  expect(text).toContain('臺鐵即時看板｜臺北');
  expect(numbers(text)).toEqual(['4193', '2037', '1232', '128']);
  expect([...text.matchAll(/離站 (\d{2}:\d{2})/g)].map(m => m[1])).toEqual(['18:20', '18:25', '18:25', '18:28']);
  expect(text).toContain('晚 2 分');
  expect(text).toContain('準點');
  expect(text).toContain('資料更新：2026-10-29 18:18（臺北時間）');
  expect(text).not.toContain('月台');
});

it('formats captured TRA train 2037 as departed from 松山 with a two-minute delay', async () => {
  const text = success(await service().live({ train_no: '2037' }));
  expect(text).toContain('2037 次｜區間快｜晚 2 分');
  expect(text).toContain('目前位置：松山（已離站）');
  expect(text).toContain('資料更新：2026-10-29 18:18（臺北時間）');
});
