// Development/test only. This module is never imported by src or the plugin bundle.
import { readFileSync } from 'node:fs';
import type { RailHttp } from '../src/core/rail/client.js';
export function railFixture(file: string, kind = 'synthetic'): any {
  return JSON.parse(readFileSync(new URL(`../test/fixtures/tdx/${kind}/${file}.json`, import.meta.url), 'utf8'));
}
export const fixtureHttp: RailHttp = async (input, init) => {
  const url = new URL(input);
  if (url.pathname.endsWith('/token')) return { status: 200, json: async () => railFixture('token') };
  if (url.searchParams.get('$format') !== 'JSON' || url.searchParams.has('$top')) throw new Error('Unexpected fixture request');
  let file: string;
  if (url.pathname.includes('THSR/Station')) file = 'thsr-stations';
  else if (url.pathname.includes('THSR/DailyTimetable/OD/')) file = 'thsr-od';
  else if (url.pathname.includes('TRA/StationLiveBoard/Station/')) file = 'tra-station-live';
  else if (url.pathname.includes('TRA/TrainLiveBoard/TrainNo/')) {
    const data = railFixture('tra-train-live');
    data.TrainLiveBoards = data.TrainLiveBoards.filter((r: { TrainNo: string }) => r.TrainNo === url.pathname.split('/').at(-1));
    data.Count = data.TrainLiveBoards.length;
    return { status: 200, json: async () => data };
  } else if (url.pathname.includes('TRA/DailyTrainTimetable/OD/')) file = 'tra-od';
  else if (url.pathname.endsWith('TRA/Station')) file = 'tra-stations';
  else throw new Error('Unexpected fixture path');
  return { status: 200, json: async () => railFixture(file) };
};
