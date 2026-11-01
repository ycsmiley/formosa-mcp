import { expect, it } from 'vitest';
import { crc32, readZip } from '../src/outage/zip.js';
import { taiwater, taipeiwater, taipower } from '../src/core/outage/normalize.js';
import { dailyTimes, parseDate } from '../src/core/outage/time.js';
import { decodeIndex, decodeShard } from '../src/core/outage/model.js';
import { fixture, powerCsv, zip } from './outage-fixtures.js';
it('reads stored/deflated data entries, ignores schema/manifest, and rejects broken ZIPs', () => {
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  const files = readZip(zip([['manifest.csv', 'skip', 0], ['schema-101.csv', 'skip', 8], ['101.csv', powerCsv(), 8], ['102.csv', 'stored', 0]]));
  expect([...files.keys()]).toEqual(['101.csv', '102.csv']); expect(files.get('101.csv')).toBe(powerCsv()); expect(files.get('102.csv')).toBe('stored');
  expect(() => readZip(new Uint8Array())).toThrow('ZIP');
  const corrupt = Buffer.from(zip([['101.csv', 'abc', 0]])); corrupt[37] ^= 1;
  expect(() => readZip(corrupt)).toThrow('ZIP'); expect(() => readZip(zip().slice(0, -1))).toThrow('ZIP');
});
it('normalizes BOM, 台, legacy Taoyuan, windows, county-only rows and grouped power ranges', () => {
  const result = taipower(new Map([['101.csv', powerCsv()]]), 1);
  expect(result.rows).toBe(7); expect(result.dropped).toBe(2); expect(result.items).toHaveLength(4);
  const ke = result.items.find(i => i.n === 'H20520')!; expect(ke.a).toContain('基金一路'); expect(ke.a).toContain('基金二路'); expect(ke.u).toMatch(/\/d101$/);
  expect(result.items.find(i => i.n === 'T1')).toMatchObject({ c: '臺北市', d: '信義區', t: [['2026-11-05T23:20', '2026-11-06T00:49'], ['2026-11-06T10:00', '2026-11-06T11:00']] });
  expect(result.items.find(i => i.n === 'P1')).toMatchObject({ c: '桃園市', d: '桃園市' }); expect(result.items.find(i => i.n === 'S1')!.d).toBe('');
  expect(() => taipower(new Map([['101.csv', powerCsv()]]))).toThrow('筆數不足');
});
it('expands Taipei Water daily ROC windows and inherits counties across all districts', () => {
  const items = taipeiwater(JSON.parse(fixture('taipeiwater.json')));
  expect(items.filter(i => i.n === 'N115001').map(i => [i.c, i.d])).toEqual([['臺北市', '中山區'], ['臺北市', '大安區'], ['新北市', '永和區'], ['新北市', '中和區']]);
  expect(items[0].t).toEqual([['2026-11-05T10:00', '2026-11-05T18:00'], ['2026-11-06T10:00', '2026-11-06T18:00']]);
  expect(items[0].a).not.toMatch(/\s$/); expect(items[0].u).toContain('N115001'); expect(items.at(-1)!.t).toContain('另行公告'); expect(taipeiwater([])).toEqual([]);
  expect(dailyTimes('115年11月03日', '10:00~18:00')).toEqual([['2026-11-03T10:00', '2026-11-03T18:00']]);
});
it.each(['2026-11-03 09:00:00', '2026/11/03 09:00', '115-11-03 09:00', '115/11/03 09:00', '115年11月03日 09:00', '2026-11-03T01:00:00Z', '2026-11-03T09:00:00+08:00'])('parses %s to Taipei local time', value => { expect(parseDate(value)).toBe('2026-11-03T09:00'); });
it('keeps unknown Taiwan Water times and maps multiple counties/districts with fallback areas', () => {
  const items = taiwater(JSON.parse(fixture('taiwater.json')));
  expect(items.filter(i => i.n === 'W1').map(i => [i.c, i.d])).toEqual([['新北市', '板橋區'], ['桃園市', '桃園區']]); expect(items[0].a).toContain('降壓：文化路二段');
  expect(items.find(i => i.n === 'W2')).toMatchObject({ c: '臺中市', d: '北屯區' }); expect(items.find(i => i.n === 'W3')).toMatchObject({ t: '待確認～另行公告', r: '降壓維護' });
  expect(taiwater([{ 影響縣市: '新北市', 停水地區: '板橋區文化路', 案件日期時間: '115年11月03日 09:00', 恢復日期時間: '2026-11-03 18:00' }])[0]).toMatchObject({ c: '新北市', d: '板橋區' });
  expect(() => taiwater(JSON.parse(fixture('empty.json')))).toThrow('空清單'); expect(() => taiwater({})).toThrow('格式錯誤'); expect(parseDate('2026-02-30 09:00')).toBeNull();
});
it('rejects malformed snapshots rather than treating them as no announcements', () => {
  expect(() => decodeIndex('{}')).toThrow(); expect(() => decodeShard('[{}]', 'taipower', '臺北市')).toThrow();
});
