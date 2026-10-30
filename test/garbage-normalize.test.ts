import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalize, parseCsv, time, type City } from '../src/core/garbage/normalize.js';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/garbage/real/${name}`, import.meta.url), 'utf8');
const capture = new Date('2026-10-30T06:50:00Z');
describe('garbage source normalization', () => {
  for (const [city, file] of [['ntpc', 'ntpc.csv'], ['taipei', 'taipei.csv'], ['taichung', 'taichung.json'], ['tainan', 'tainan.json'], ['kaohsiung', 'kaohsiung.json']] as [City, string][]) {
    it(`normalizes the ${city} capture`, () => {
      const stops = normalize(city, fixture(file), capture);
      expect(stops.length).toBeGreaterThan(0);
      expect(stops.every(s => s.district && s.name && [...s.garbage, ...s.recycling, ...s.food].every(slot => /^\d\d:\d\d$/.test(slot.start)))).toBe(true);
    });
  }
  it('reads quoted commas, newlines, escapes and BOM', () => {
    expect(parseCsv('\ufeffa,b\r\n"x,y","a""b\nq"\r\n')).toEqual([{ a: 'x,y', b: 'a"b\nq' }]);
  });
  it('reads explicit Taipei recycling days from stop names', () => {
    for (const csv of [fixture('taipei.csv'), fixture('taipei.csv').replace('每週二,五回收車', '每週二、五回收車')]) {
      const stop = normalize('taipei', csv, capture).find(s => s.name.includes('登山路25之1號'))!;
      expect(stop.garbage[0].days).toBe(118);
      expect(stop.recycling[0].days).toBe((1 << 2) | (1 << 5));
    }
  });
  it('drops placeholder New Taipei memos', () => {
    const header = 'city,linename,name,village,time,memo,garbagemonday';
    const [stop] = normalize('ntpc', `${header}\n板橋區,C01,文化路1段1號,留侯里,19:00,-,Y`, new Date());
    expect(stop.note).toBeUndefined();
  });
  it('groups Taichung days with the same time', () => {
    const stop = normalize('taichung', fixture('taichung.json'), capture)[0];
    expect(stop.garbage).toEqual([{ days: 118, start: '16:40', end: '16:41' }]);
  });
  it('uses capture weekday and merges Kaohsiung rows', () => {
    const row = { area: '三民區', village: '里', area_name: '一', trips_name: '1', caption: '地點', today_s: '16:25', today_e: '16:29' };
    const stops = normalize('kaohsiung', JSON.stringify({ data: [{ ...row, task: '垃圾' }, { ...row, task: '資收' }] }), capture);
    expect(stops).toHaveLength(1);
    expect(stops[0].garbage[0].days).toBe(1 << 5);
    expect(stops[0].recycling[0].days).toBe(1 << 5);
  });
  it('skips 往廠 and treats 無清運 as no recycling', () => {
    expect(normalize('taichung', JSON.stringify([{ area: '區', caption: '地點', task_type: '往廠', g_d1_time_s: '12:00' }]), capture)).toEqual([]);
    const [stop] = normalize('tainan', JSON.stringify({ data: [{ AREA: '區', POINTNAME: '地點', TIME: '9:30', WORKDAY: '日、一', RECYCLEDAY: '無清運' }] }), capture);
    expect(stop.garbage).toEqual([{ days: 3, start: '09:30', end: '' }]);
    expect(stop.recycling).toEqual([]);
    expect(time('24:00')).toBe('');
  });
});
