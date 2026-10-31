import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalize, parseCsv, time, type City } from '../src/core/garbage/normalize.js';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/garbage/real/${name}`, import.meta.url), 'utf8');
const capture = new Date('2026-10-30T06:50:00Z');
describe('garbage source normalization', () => {
  for (const [city, file] of [['ntpc', 'ntpc.csv'], ['taipei', 'taipei.csv'], ['taichung', 'taichung.json']] as [City, string][]) {
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
      expect(stop.garbage).toEqual([]);
      expect(stop.food).toEqual([]);
      expect(stop.recycling[0].days).toBe((1 << 2) | (1 << 5));
      expect(stop.note).toBe('僅資源回收車收運');
    }
  });
  it('marks Taipei recycling truck stops as recycling only', () => {
    const stops = normalize('taipei', fixture('taipei.csv'), capture);
    for (const tag of ['(回收車收運)', '(回收車)', '(由回收車收運)']) {
      const stop = stops.find(s => s.name.includes(tag))!;
      expect(stop.garbage).toEqual([]);
      expect(stop.food).toEqual([]);
      expect(stop.recycling[0].days).toBe(118);
      expect(stop.note).toBe('僅資源回收車收運');
    }
  });
  it('assigns Taipei food waste to normal garbage slots', () => {
    const stop = normalize('taipei', fixture('taipei.csv'), capture).find(s => s.garbage.length)!;
    expect(stop.food).toEqual(stop.garbage);
    expect(stop.food[0].days).toBe(118);
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
  it('skips 往廠 and rejects invalid times', () => {
    expect(normalize('taichung', JSON.stringify([{ area: '區', caption: '地點', task_type: '往廠', g_d1_time_s: '12:00' }]), capture)).toEqual([]);
    expect(time('24:00')).toBe('');
  });
});
