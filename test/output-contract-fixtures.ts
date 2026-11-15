// Shared, offline fixtures for both Vitest pools. Only test code imports this file.
import xml from './fixtures/invoice.xml?raw';
import garbageCsv from './fixtures/garbage/real/ntpc.csv?raw';
import powerCsv from './fixtures/outage/taipower.csv?raw';
import water from './fixtures/outage/taipeiwater.json';
import dgpaHtml from './fixtures/disaster/dgpa-nds-2026-11-02-no-event.html?raw';
import ncdrJson from './fixtures/disaster/ncdr-JSONAtomFeeds-active-2026-11-02.json';
import cap from './fixtures/disaster/ncdr-cap-cwa-strong-wind.cap?raw';
import thsrStations from './fixtures/tdx/real/thsr-stations.json';
import traStations from './fixtures/tdx/real/tra-stations.json';
import thsrOD from './fixtures/tdx/real/thsr-od-1000-1070.json';
import traOD from './fixtures/tdx/real/tra-od-1000-4400.json';
import liveTrain from './fixtures/tdx/real/tra-train-live-2037.json';
import { stockUrls, marketUrls } from '../src/core/stock/source.js';
import { buildMarketSummary } from '../src/core/stock/market.js';
import { buildInvoiceSnapshot, buildStockSnapshot, encodeSnapshot, encodeQuotesSnapshot } from '../src/core/snapshot.js';
import { buildCity } from '../src/core/garbage/build.js';
import { decodeShard as decodeGarbage, indexKey as garbageKey, shardKey as garbageShardKey } from '../src/core/garbage/snapshot.js';
import { taipeiwater, taipower } from '../src/core/outage/normalize.js';
import { indexKey as outageKey, shardKey as outageShardKey, type Index as OutageIndex } from '../src/core/outage/model.js';
import { parseDgpa, parseCap } from '../src/core/disaster/parse.js';
import { indexKey as disasterKey, shardKey as disasterShardKey, type Index as DisasterIndex } from '../src/core/disaster/model.js';
import { compactStations, compactTimetable, stationKey, timetableKey } from '../src/core/rail/snapshot.js';
import type { ServerOptions } from '../src/mcp/server.js';
export const now = '2026-11-02T01:15:00.000Z';
export const clock = () => new Date(now);
// 2000 is an archival sample, NOT a newly invented production threshold.
export const archive = '2000-01-01T00:00:00.000Z';
// A dated dividend snapshot distinct from the Nov 20 query; also crosses a
// Taipei midnight boundary so the contract checks the displayed data day.
export const dividendUpdatedAt = '2026-10-22T16:30:00.000Z';
export const cases: Record<string, Record<string, unknown>> = {
  invoice_get_winning_numbers: {}, invoice_check: { number: '54348835', period: '11508' },
  stock_quote: { query: '6488' }, stock_market_summary: {}, stock_dividends: {},
  garbage_schedule: { city: '新北市', district: '板橋區', keyword: '民生路' },
  outage_schedule: { city: '臺北市', district: '信義區', type: 'power', start_date: '2026-11-05', end_date: '2026-11-06' },
  work_school_closure: { city: '臺北市' }, disaster_alerts: { city: '臺北市' },
  thsr_timetable: { origin: '臺北', destination: '高雄', date: '2026-11-02', time: '00:00' },
  tra_timetable: { origin: '臺北', destination: '高雄', date: '2026-11-02', time: '00:00' }, tra_live: { train_no: '2037' },
};
// Audit of createServer injection paths and src/worker/index.ts:70-76 +
// worker/rail.ts:59-102. Local market/rail/invoice/stock caches fetch on expiry;
// they do not serve persisted snapshots. TPEx fallback's heartbeat is a cron
// dispatch decision, not a tool; stock_quote reads it to warn about stale TPEx.
export const snapshotReaders = {
  local: ['garbage_schedule', 'outage_schedule', 'work_school_closure', 'disaster_alerts'],
  worker: ['invoice_get_winning_numbers', 'invoice_check', 'stock_quote', 'stock_market_summary', 'stock_dividends', 'garbage_schedule', 'outage_schedule', 'work_school_closure', 'disaster_alerts', 'thsr_timetable', 'tra_timetable', 'tra_live'],
};
// No staleness threshold exists yet for these snapshot readers; tracked in
// https://github.com/ycsmiley/formosa-mcp/issues/7.
// They still must provide attribution, meaningful data time, and formatted text.
export const STALE_WARNING_EXEMPT = [
  'invoice_get_winning_numbers', 'invoice_check', 'stock_dividends',
  'thsr_timetable', 'tra_timetable', 'tra_live',
];
// Independent case maps: removing a case fails coverage; removing a reader fails
// the reverse audit against this map. These are existing warning phrases only.
export const staleCases: Record<string, { warning: RegExp; args?: Record<string, unknown> }> = {
  // garbage/service.ts:76: >3 days. Archive is far past that (shard retained).
  garbage_schedule: { warning: /資料可能已過時/ },
  // outage/service.ts:69-71: >24h. All sources retain readable successful shards.
  outage_schedule: { warning: /資料可能過期/ },
  // disaster/service.ts:50-51: >=90m fetch age; NCDR source expires after 24h.
  // Keep NCDR sourceUpdatedAt fresh, age lastSuccessAt by 3h to test its warning.
  work_school_closure: { warning: /資料可能過期/ }, disaster_alerts: { warning: /資料可能過期/ },
  // stock/format.ts:24-27: >=3 intervening weekdays; market.ts:85-94: >1.
  stock_quote: { warning: /資料停在|櫃買資料可能延遲/ }, stock_market_summary: { warning: /資料停在/ },
};
const stock = import.meta.glob('./fixtures/stock/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
export const stockFixture = (name: string): any => stock[`./fixtures/stock/${name.replaceAll('-', '_')}.json`];
export const stockFetch = async (url: string) => {
  const key = Object.entries(stockUrls).find(([, u]) => u === url)?.[0];
  if (!key) throw Error('unexpected stock fixture URL');
  return structuredClone(stockFixture(key));
};
export const marketInput = (fetchedAt = now) => {
  const headers = stockFixture('market-headers');
  return { fmtqik: stockFixture('market-fmtqik'), margn: stockFixture('market-margn'), tpexIndex: stockFixture('market-tpex-index'), tpexMargin: stockFixture('market-tpex-margin'),
    fmtqikLastModified: headers.fmtqik['last-modified'], margnLastModified: headers.margn['last-modified'], fetchedAt };
};
export const marketFeed = async (url: string) => {
  const key = Object.entries(marketUrls).find(([, u]) => u === url)?.[0] as keyof typeof marketUrls;
  if (!key) throw Error('unexpected market fixture URL');
  return { body: marketInput()[key], lastModified: stockFixture('market-headers')[key]['last-modified'] };
};
// Fixture key inventory feeds the raw-key denylist; use actual JSON keys and CSV
// headers, not made-up field names. Shared in node and Workers.
export const upstreamObjects = [...Object.values(stock), water, ncdrJson, thsrStations, traStations, thsrOD, traOD, liveTrain];
export const upstreamColumns = [garbageCsv, powerCsv].flatMap(csv => csv.trim().split(/\r?\n/)[0].replace(/^\uFEFF/, '').split(','));
export async function fixtureData(stale = false) {
  const time = stale ? archive : now;
  const values = new Map<string, string>();
  const garbage = await buildCity('ntpc', garbageCsv, new Date(time));
  const garbageIndex = { v: 2 as const, generatedAt: time, cities: { ntpc: garbage.entry } };
  values.set(garbageKey, JSON.stringify(garbageIndex));
  for (const [district, shard] of garbage.shards) values.set(garbageShardKey('ntpc', garbage.entry.gen, district), shard);
  const items = [...taipeiwater(water).items, ...taipower(new Map([['101.csv', powerCsv]]), 1).items];
  const outageIndex: OutageIndex = { v: 1, generatedAt: time, sources: {} };
  for (const source of ['taipeiwater', 'taipower'] as const) {
    const rows = items.filter(i => i.s === source), counties: NonNullable<OutageIndex['sources'][typeof source]>['counties'] = {};
    for (const county of new Set(rows.map(i => i.c))) {
      const group = rows.filter(i => i.c === county), sha = 'a'.repeat(64);
      counties[county] = { sha, count: group.length, writtenAt: time };
      values.set(outageShardKey(source, county, sha), JSON.stringify(group));
    }
    outageIndex.sources[source] = { ok: true, fetchedAt: time, lastSuccessAt: time, counties };
  }
  values.set(outageKey, JSON.stringify(outageIndex));
  const dgpa = parseDgpa(dgpaHtml), parsedCap = parseCap(cap);
  const alerts = [{ ...parsedCap, link: 'https://alerts.ncdr.nat.gov.tw/', detail: true }];
  // parseCap's normalized alert has real timestamps/counties; preserve them.
  const sha = 'a'.repeat(12), disasterIndex: DisasterIndex = { v: 1, writer: 'worker', heartbeatAt: now, sources: {} };
  const dgpaTime = new Date(Date.parse(now) - (stale ? 3 * 3600000 : 0)).toISOString();
  for (const source of ['dgpa', 'ncdr'] as const) disasterIndex.sources[source] = { ok: true, sha, count: source === 'dgpa' ? Object.keys(dgpa.counties).length : alerts.length,
    fetchedAt: dgpaTime, lastSuccessAt: dgpaTime, sourceUpdatedAt: source === 'dgpa' ? dgpaTime : now, writtenAt: dgpaTime };
  values.set(disasterKey('worker'), JSON.stringify(disasterIndex));
  values.set(disasterShardKey('dgpa', sha), JSON.stringify(dgpa)); values.set(disasterShardKey('ncdr', sha), JSON.stringify(alerts));
  const invoice = await buildInvoiceSnapshot(async () => xml, () => new Date(time));
  values.set('invoice:v1', encodeSnapshot(invoice));
  for (const market of ['twse', 'tpex'] as const) {
    const data = await buildStockSnapshot(market, stockFetch, () => new Date(time));
    values.set(`stock:quotes:${market}:v1`, encodeQuotesSnapshot(data.quotes!));
    values.set(`stock:dividends:${market}:v1`, encodeSnapshot({ ...data.dividends!, updatedAt: stale ? dividendUpdatedAt : time }));
  }
  // Dates are the fixture feed dates; moving the clock to Nov 20 is well beyond
  // the existing weekday-based stock thresholds, including TPEx heartbeat age.
  values.set('stock:collect:tpex:v1', JSON.stringify({ v: 1, lastSuccessAt: time, dataDate: '2026-10-29' }));
  values.set('stock:market:v1', JSON.stringify(buildMarketSummary(marketInput(time))));
  const thsrDaily = thsrOD.map(row => ({ DailyTrainInfo: row.DailyTrainInfo, StopTimes: [row.OriginStopTime, row.DestinationStopTime] }));
  for (const railway of ['THSR', 'TRA'] as const) {
    values.set(stationKey(railway), JSON.stringify(compactStations(railway, railway === 'THSR' ? thsrStations : traStations, time)));
    // Keep a covered operating date while aging the actual acquisition time.
    values.set(timetableKey(railway, '2026-11-02'), JSON.stringify(compactTimetable(railway, railway === 'THSR' ? thsrDaily : traOD, '2026-11-02', time)));
  }
  const options: ServerOptions = {
    toolsets: ['invoice', 'stock', 'garbage', 'outage', 'disaster', 'rail'], clock, fetchFeed: async () => xml, fetchJson: stockFetch, fetchMarketFeed: marketFeed,
    garbageStore: { index: async () => garbageIndex, shard: async (_c, _g, district, keyword, filter) => decodeGarbage(garbage.shards.get(district)!, district, keyword, filter) },
    outageStore: { index: async () => outageIndex, shard: async (s, c, hash) => JSON.parse(values.get(outageShardKey(s, c, hash))!) },
    disasterStore: { indexes: async () => ({ worker: disasterIndex, gha: null }), shard: async s => s === 'dgpa' ? dgpa : alerts },
  };
  return { values, options, liveTrain };
}
