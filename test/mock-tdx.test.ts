import { expect, it, vi } from 'vitest';
import { createMockTdxHandler } from '../scripts/mock-tdx.mjs';
import { compactStations, compactTimetable } from '../src/core/rail/snapshot.js';

it('serves fixture-based token/live/snapshot shapes for any date and records requests without reading bodies', () => {
  const handler = createMockTdxHandler();
  const get = (url: string, method = 'GET') => {
    let status = 0, body: any;
    const req = { url, method, resume: vi.fn() };
    handler(req, { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = JSON.parse(text); } });
    expect(req.resume).toHaveBeenCalledOnce();
    return { status, body };
  };
  const token = get('/auth/realms/TDXConnect/protocol/openid-connect/token', 'POST');
  expect(token).toEqual({ status: 200, body: { access_token: 'mock-token', token_type: 'Bearer', expires_in: 86400 } });
  const station = get('/api/basic/v3/Rail/TRA/StationLiveBoard/Station/1000');
  expect(station.status).toBe(200);
  expect(station.body.StationLiveBoards.length).toBeGreaterThan(0);
  expect(station.body.StationLiveBoards.every((row: any) => row.StationID === '1000')).toBe(true);
  const train = get('/api/basic/v3/Rail/TRA/TrainLiveBoard/TrainNo/128');
  expect(train.body.TrainLiveBoards[0].TrainNo).toBe('128');
  expect(Date.now() - Date.parse(train.body.UpdateTime)).toBeLessThan(1000);
  for (const railway of ['THSR', 'TRA'] as const) {
    const version = railway === 'THSR' ? 'v2' : 'v3';
    const stations = get(`/api/basic/${version}/Rail/${railway}/Station`);
    expect(stations.status).toBe(200);
    const compact = compactStations(railway, stations.body, new Date().toISOString());
    expect(compact.stations.length).toBeGreaterThan(10);
    if (railway === 'TRA') expect(compact.stations.some(([, name]) => name === '新營')).toBe(true);
    const route = railway === 'THSR' ? 'DailyTimetable' : 'DailyTrainTimetable';
    const path = `/api/basic/${version}/Rail/${railway}/${route}/TrainDate/2030-01-02`;
    const timetable = get(path);
    expect(timetable.status).toBe(200);
    const snapshot = compactTimetable(railway, timetable.body, '2030-01-02', new Date().toISOString());
    expect(snapshot.trains.length).toBeGreaterThan(0);
    expect(railway === 'THSR' ? timetable.body[0].TrainDate : timetable.body.TrainDate).toBe('2030-01-02');
    const page = get(`${path}?$skip=1000&$top=1000`);
    expect(railway === 'THSR' ? page.body : page.body.TrainTimetables).toEqual([]);
  }
  expect(get('/missing').status).toBe(404);
  const stats = get('/__stats');
  expect(stats.status).toBe(200);
  expect(stats.body.calls).toHaveLength(11);
  expect(stats.body.calls[0].kind).toBe('token');
  expect(stats.body.calls.at(-1).kind).toBe('stats');
  expect(stats.body.calls.every((call: any) => Object.keys(call).sort().join() === 'kind,t' && typeof call.t === 'number')).toBe(true);
});
