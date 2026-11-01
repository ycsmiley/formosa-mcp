import { expect, it } from 'vitest';
import { crc32, readZip } from '../src/outage/zip.js';
import { locations, taiwater, taipeiwater, taipower } from '../src/core/outage/normalize.js';
import { dailyTimes, formatTimes, parseDate } from '../src/core/outage/time.js';
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
  expect(result.items.find(i => i.n === 'P1')).toMatchObject({ c: '桃園市', d: '桃園區' }); expect(result.items.find(i => i.n === 'S1')!.d).toBe('');
  expect(() => taipower(new Map([['101.csv', powerCsv()]]))).toThrow('筆數不足');
});
it('parses quoted commas, escaped quotes and line breaks in power CSV fields', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const csv = [header, '處,1,"設備,維修",無,無,臺北市信義區中正路,1911',
    '處,2,"更換""設備""",無,無,臺北市信義區中正路,1911',
    '處,3,施工,無,無,"臺北市信義區中正路\r\n一段",1911'].join('\r\n');
  const result = taipower(new Map([['101.csv', csv]]), 3);
  expect(result.rows).toBe(3); expect(result.items.map(i => i.r)).toEqual(['設備,維修', '更換"設備"', '施工']);
  expect(result.items[2].a).toBe('臺北市信義區中正路\r\n一段');
  expect(() => taipower(new Map([['101.csv', csv]]), 4)).toThrow('筆數不足');
});
it('converts legacy Taoyuan districts in power areas only', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const areas = ['桃園縣平鎮市廣泰路', '桃園縣大園鄉中正東路一段', '桃園縣新屋鄉新生五街', '新竹縣竹東鎮中正路'];
  const csv = [header, ...areas.map((area, i) => `處,${i},施工,無,無,${area},1911`)].join('\n');
  expect(taipower(new Map([['101.csv', csv]]), 1).items.map(({ c, d, a }) => [c, d, a])).toEqual([
    ['桃園市', '平鎮區', '桃園市平鎮區廣泰路'], ['桃園市', '大園區', '桃園市大園區中正東路一段'],
    ['桃園市', '新屋區', '桃園市新屋區新生五街'], ['新竹縣', '竹東鎮', '新竹縣竹東鎮中正路'],
  ]);
});
it('extracts complete districts before falling back to townships and cities', () => {
  const areas = ['桃園市平鎮區廣泰路', '臺南市新市區中正路', '新竹縣竹東鎮中正路', '嘉義縣太保市中正路'];
  const expected = [['桃園市', '平鎮區'], ['臺南市', '新市區'], ['新竹縣', '竹東鎮'], ['嘉義縣', '太保市']];
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const csv = [header, ...areas.map((area, i) => `處,${i},施工,無,無,${area},1911`)].join('\n');
  expect(taipower(new Map([['101.csv', csv]]), 1).items.map(({ c, d }) => [c, d])).toEqual(expected);
  expect(areas.map(area => locations(area).map(({ c, d }) => [c, d])[0])).toEqual(expected);
});
it('expands Taipei Water daily ROC windows and inherits counties across all districts', () => {
  const items = taipeiwater(JSON.parse(fixture('taipeiwater.json')));
  expect(items.filter(i => i.n === 'N115001').map(i => [i.c, i.d])).toEqual([['臺北市', '中山區'], ['臺北市', '大安區'], ['新北市', '永和區'], ['新北市', '中和區']]);
  expect(items[0].t).toEqual([['2026-11-05T10:00', '2026-11-05T18:00'], ['2026-11-06T10:00', '2026-11-06T18:00']]);
  expect(items[0].a).not.toMatch(/\s$/); expect(items[0].u).toContain('N115001'); expect(items.at(-1)!.t).toContain('另行公告'); expect(taipeiwater([])).toEqual([]);
  expect(dailyTimes('115年11月03日', '10:00~18:00')).toEqual([['2026-11-03T10:00', '2026-11-03T18:00']]);
});
it('trims Taipei Water fields and removes empty, duplicate and area-only reasons', () => {
  const row = { SW_No: ' N1\r\n ', Date: ' 115年11月02日\r\n ', Time: ' 10:00~16:00\r\n ', SW_Area: ' 臺北市中山區新生北路一段\r\n ', MapUrl: ' https://example.test/N1\r\n ' };
  for (const reason of [{ Title: row.SW_Area, Description: '\n臺北市中山區\n新生北路一段 ' }, { Title: '\r\n ', Description: '' }]) expect(taipeiwater([{ ...row, ...reason }])[0]).toMatchObject({ a: '臺北市中山區新生北路一段', r: '', n: 'N1', u: 'https://example.test/N1', t: [['2026-11-02T10:00', '2026-11-02T16:00']] });
  expect(taipeiwater([{ ...row, Title: row.SW_Area, Description: ' 管線汰換\r\n ' }])[0].r).toBe('管線汰換');
  expect(taipeiwater([{ ...row, Title: ' 管線汰換 ', Description: '管線汰換\r\n' }])[0].r).toBe('管線汰換');
});
it('compresses consecutive daily hours, preserves gaps/different hours and labels overnight hours', () => {
  expect(formatTimes(dailyTimes('115年11月02日~115年11月07日', '10:00~16:00'))).toBe('11/02（一）～11/07（六）每日 10:00–16:00');
  expect(formatTimes([['2026-11-02T10:00', '2026-11-02T16:00'], ['2026-11-04T10:00', '2026-11-04T16:00'], ['2026-11-05T11:00', '2026-11-05T16:00'], ['2026-11-06T23:00', '2026-11-07T01:00']])).toBe('11/02（一）10:00–16:00；11/04（三）10:00–16:00；11/05（四）11:00–16:00；11/06（五）23:00–11/07（六）01:00');
  expect(formatTimes(dailyTimes('115年11月02日~115年11月03日', '23:00~01:00'))).toBe('11/02（一）～11/03（二）每日 23:00–翌日 01:00');
});
it.each(['2026-11-03 09:00:00', '2026/11/03 09:00', '115-11-03 09:00', '115/11/03 09:00', '115年11月03日 09:00', '2026-11-03T01:00:00Z', '2026-11-03T09:00:00+08:00'])('parses %s to Taipei local time', value => { expect(parseDate(value)).toBe('2026-11-03T09:00'); });
it('keeps unknown Taiwan Water times and maps multiple counties/districts with fallback areas', () => {
  const items = taiwater(JSON.parse(fixture('taiwater.json')));
  expect(items.filter(i => i.n === 'W1').map(i => [i.c, i.d])).toEqual([['新北市', '板橋區'], ['桃園市', '桃園區']]); expect(items[0].a).toContain('降壓：文化路二段');
  expect(items.find(i => i.n === 'W2')).toMatchObject({ c: '臺中市', d: '北屯區' }); expect(items.find(i => i.n === 'W3')).toMatchObject({ t: '待確認～另行公告', r: '降壓維護' });
  expect(taiwater([{ 影響縣市: '新北市', 停水地區: '板橋區文化路', 案件日期時間: '115年11月03日 09:00', 恢復日期時間: '2026-11-03 18:00' }])[0]).toMatchObject({ c: '新北市', d: '板橋區' });
  expect(() => taiwater(JSON.parse(fixture('empty.json')))).toThrow('空清單'); expect(() => taiwater({})).toThrow('格式錯誤'); expect(parseDate('2026-02-30 09:00')).toBeNull();
});
it('retains explicitly listed districts missing from multi-county area text', () => {
  const items = taiwater([{ 影響縣市: '新北市、桃園市', 影響行政區: '板橋區、中和區、桃園區', 停水地區: '新北市板橋區文化路、桃園市桃園區中正路' }]);
  expect(items.map(i => [i.c, i.d])).toEqual([['新北市', '板橋區'], ['新北市', '中和區'], ['桃園市', '中和區'], ['桃園市', '桃園區']]);
});
it('rejects malformed snapshots rather than treating them as no announcements', () => {
  expect(() => decodeIndex('{}')).toThrow(); expect(() => decodeShard('[{}]', 'taipower', '臺北市')).toThrow();
  const index = { v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { taipower: { ok: true, counties: { 臺北市: { sha: 'a'.repeat(64), count: 1, writtenAt: 'bad' } } } } };
  expect(() => decodeIndex(JSON.stringify(index))).toThrow('公告縣市格式錯誤'); index.sources.taipower.counties.臺北市.writtenAt = index.generatedAt; expect(decodeIndex(JSON.stringify(index))).toEqual(index);
});

it('infers a district county only from unambiguous rows in the same office file', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const csv = (areas: string[]) => [header, ...areas.map((area, i) => `處,${i},施工,無,無,${area},1911`)].join('\n');
  const result = taipower(new Map([
    ['101.csv', csv(['北屯區東山路一段', '臺中市北屯區松竹路', '中山區中正路', '臺北市中山區一街', '基隆市中山區二街', '東區三街'])],
    ['102.csv', csv(['新竹市東區四街'])],
  ]), 1);
  expect(result.items.find(i => i.a.includes('東山路'))).toMatchObject({ c: '臺中市', d: '北屯區', a: '臺中市北屯區東山路一段' });
  expect(result.dropped).toBe(2);
});
it('validates the optional dropped row count in the index', () => {
  const entry = { ok: true, counties: {}, dropped: 2 };
  const index = { v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { taipower: entry } };
  expect(decodeIndex(JSON.stringify(index)).sources.taipower?.dropped).toBe(2);
  for (const dropped of [-1, 1.5, '2', null]) expect(() => decodeIndex(JSON.stringify({ ...index, sources: { taipower: { ...entry, dropped } } }))).toThrow();
});
