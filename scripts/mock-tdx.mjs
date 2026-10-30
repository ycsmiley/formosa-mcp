#!/usr/bin/env node
// Local-only TDX simulation. All data is synthetic or adapted from checked-in fixtures.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../test/fixtures/tdx/real/${name}.json`, import.meta.url), 'utf8'));
}
const [traStations, thsrStations, stationLive, trainLive, traOD, thsrOD] = await Promise.all([
  'tra-stations', 'thsr-stations', 'tra-station-live-1000', 'tra-train-live-2037', 'tra-od-1000-4400', 'thsr-od-1000-1070',
].map(fixture));
// The real fixture intentionally contains only a station subset. Use explicitly
// synthetic IDs for missing names so every abuse-test station exercises the gateway.
for (const [i, name] of ['板橋', '新竹', '彰化', '嘉義', '臺南', '臺東', '宜蘭', '南港', '中壢', '苗栗', '斗六', '新營'].entries()) {
  if (!traStations.Stations.some(station => station.StationName.Zh_tw === name)) {
    traStations.Stations.push({ StationID: `mock-${i}`, StationName: { Zh_tw: name, En: `Mock station ${i}` } });
  }
}
function fresh(value, now, date) {
  if (Array.isArray(value)) return value.map(item => fresh(item, now, date));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['UpdateTime', 'SrcUpdateTime'].includes(key) ? now : key === 'TrainDate' && date ? date : fresh(item, now, date),
  ]));
}
function options() {
  const opts = { host: process.env.MOCK_TDX_HOST ?? '127.0.0.1', port: process.env.MOCK_TDX_PORT ?? '8790' };
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/mock-tdx.mjs [--host 127.0.0.1|localhost|::1] [--port 8790]\nLocal only. GET /__stats returns all requests; no request bodies are logged.');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !Object.hasOwn(opts, key) || !args[i + 1]) throw new Error(`Invalid option: ${args[i]}`);
    opts[key] = args[++i];
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(opts.host)) throw new Error('Mock host must be loopback');
  if (!/^\d+$/.test(opts.port) || Number(opts.port) < 1 || Number(opts.port) > 65535) throw new Error('Invalid port');
  return { ...opts, port: Number(opts.port) };
}
export function createMockTdxHandler() {
  const calls = [];
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    const now = new Date().toISOString();
    let kind = 'unknown', status = 200, body;
    // Drain bodies without reading, storing, or logging them.
    req.resume();
    if (path === '/__stats' && req.method === 'GET') { kind = 'stats'; body = { calls }; }
    else if (path === '/auth/realms/TDXConnect/protocol/openid-connect/token' && req.method === 'POST') {
      kind = 'token'; body = { access_token: 'mock-token', token_type: 'Bearer', expires_in: 86400 };
    } else if (req.method === 'GET') {
      const station = /^\/api\/basic\/v3\/Rail\/TRA\/StationLiveBoard\/Station\/([A-Za-z0-9_-]+)$/.exec(path);
      const train = /^\/api\/basic\/v3\/Rail\/TRA\/TrainLiveBoard\/TrainNo\/(\d+)$/.exec(path);
      const thsr = /^\/api\/basic\/v2\/Rail\/THSR\/DailyTimetable\/TrainDate\/(\d{4}-\d{2}-\d{2})$/.exec(path);
      const tra = /^\/api\/basic\/v3\/Rail\/TRA\/DailyTrainTimetable\/TrainDate\/(\d{4}-\d{2}-\d{2})$/.exec(path);
      if (station) {
        kind = 'tra-live-station'; body = fresh(stationLive, now);
        const name = traStations.Stations.find(row => row.StationID === station[1])?.StationName ?? { Zh_tw: '模擬站', En: 'Mock' };
        body.StationLiveBoards = body.StationLiveBoards.slice(0, 3).map(row => ({ ...row, StationID: station[1], StationName: name }));
      } else if (train) {
        kind = 'tra-live-train'; body = fresh(trainLive, now);
        body.TrainLiveBoards = body.TrainLiveBoards.map(row => ({ ...row, TrainNo: train[1] }));
      } else if (path === '/api/basic/v3/Rail/TRA/Station') { kind = 'tra-stations'; body = fresh(traStations, now); }
      else if (path === '/api/basic/v2/Rail/THSR/Station') { kind = 'thsr-stations'; body = fresh(thsrStations, now); }
      else if (thsr) {
        kind = 'thsr-timetable';
        body = fresh(thsrOD, now, thsr[1]).map(({ OriginStopTime, DestinationStopTime, ...row }) => ({ ...row, StopTimes: [OriginStopTime, DestinationStopTime] }));
      } else if (tra) { kind = 'tra-timetable'; body = fresh(traOD, now, tra[1]); }
      // Support the same pagination query as the snapshot refresh.
      if (thsr || tra) {
        const skip = Number(url.searchParams.get('$skip') ?? 0), top = Number(url.searchParams.get('$top') ?? 1000);
        if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(top) || top < 1) {
          status = 400; body = { error: 'Invalid pagination' };
        } else if (thsr) body = body.slice(skip, skip + top);
        else body.TrainTimetables = body.TrainTimetables.slice(skip, skip + top);
      }
    }
    if (body === undefined) { status = 404; body = { error: 'Unknown mock endpoint' }; }
    calls.push({ t: Date.now(), kind });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
}
function start(opts) {
  const server = createServer(createMockTdxHandler());
  server.on('error', () => { console.error('mock-tdx: unable to listen on the requested loopback address'); process.exitCode = 1; });
  server.listen(opts.port, opts.host, () => console.log(`mock-tdx listening on loopback port ${opts.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const opts = options(); if (opts) start(opts); }
  catch (error) { console.error(`mock-tdx: ${error.message}`); process.exitCode = 1; }
}
