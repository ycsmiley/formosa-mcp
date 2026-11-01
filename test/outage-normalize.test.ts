import { expect, it } from 'vitest';
import { crc32, readZip } from '../src/outage/zip.js';
import { canonical, countiesForOffice, locations, taiwater, taipeiwater, taipower } from '../src/core/outage/normalize.js';
import { dailyTimes, formatTimes, parseDate } from '../src/core/outage/time.js';
import { decodeIndex, decodeShard } from '../src/core/outage/model.js';
import { counties, districts, resolveDistrict } from '../src/core/outage/districts.js';
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
  expect(result.rows).toBe(7); expect(result.dropped).toBe(1); expect(result.items).toHaveLength(5);
  const ke = result.items.find(i => i.n === 'H20520')!; expect(ke.a).toContain('基金一路'); expect(ke.a).toContain('基金二路'); expect(ke.u).toMatch(/\/d101$/);
  expect(result.items.find(i => i.n === 'T1')).toMatchObject({ c: '臺北市', d: '信義區', t: [['2026-11-05T23:20', '2026-11-06T00:49'], ['2026-11-06T10:00', '2026-11-06T11:00']] });
  expect(result.items.find(i => i.n === 'H15648')).toMatchObject({ c: '臺中市', d: '北屯區', a: '臺中市北屯區東山路一段' });
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
  expect(result.items[2].a).toBe('臺北市信義區中正路 一段');
  expect(() => taipower(new Map([['101.csv', csv]]), 4)).toThrow('筆數不足');
});
it('keeps office-like lines inside closed quoted fields and recovers an unterminated row', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const text = [header, '台電台中區營業處,a,"施工\n台電台中區營業處,文字",無,無,北屯區一街,1911',
    '台電新營區營業處,b,"未結束', '台電台中區營業處,"c",施工,無,無,北屯區二街,1911'].join('\n');
  const result = taipower(new Map([['101.csv', text]]), 1);
  expect(result.rows).toBe(3); expect(result.dropped).toBe(1);
  expect(result.items.map(i => [i.n, i.r])).toEqual([['a', '施工 台電台中區營業處,文字'], ['c', '施工']]);
});
it('converts legacy Taoyuan districts without corrupting 平鎮區', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const areas = ['桃園縣平鎮市廣泰路', '桃園縣平鎮區廣泰路', '桃園縣大園鄉中正東路一段', '桃園縣新屋鄉新生五街', '新竹縣竹東鎮中正路'];
  const csv = [header, ...areas.map((area, i) => `處,${i},施工,無,無,${area},1911`)].join('\n');
  expect(taipower(new Map([['101.csv', csv]]), 1).items.map(({ c, d, a }) => [c, d, a])).toEqual([
    ['桃園市', '平鎮區', '桃園市平鎮區廣泰路'], ['桃園市', '平鎮區', '桃園市平鎮區廣泰路'], ['桃園市', '大園區', '桃園市大園區中正東路一段'],
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
  const items = taipeiwater(JSON.parse(fixture('taipeiwater.json'))).items;
  expect(items.filter(i => i.n === 'N115001').map(i => [i.c, i.d])).toEqual([['臺北市', '中山區'], ['臺北市', '大安區'], ['新北市', '永和區'], ['新北市', '中和區']]);
  expect(items[0].t).toEqual([['2026-11-05T10:00', '2026-11-05T18:00'], ['2026-11-06T10:00', '2026-11-06T18:00']]);
  expect(items[0].a).not.toMatch(/\s$/); expect(items[0].u).toContain('N115001'); expect(items.at(-1)!.t).toContain('另行公告'); expect(taipeiwater([])).toEqual({ items: [], dropped: 0, rows: 0 });
  expect(dailyTimes('115年11月03日', '10:00~18:00')).toEqual([['2026-11-03T10:00', '2026-11-03T18:00']]);
});
it('trims Taipei Water fields and removes empty, duplicate and area-only reasons', () => {
  const row = { SW_No: ' N1\r\n ', Date: ' 115年11月02日\r\n ', Time: ' 10:00~16:00\r\n ', SW_Area: ' 臺北市中山區新生北路一段\r\n ', MapUrl: ' https://example.test/N1\r\n ' };
  for (const reason of [{ Title: row.SW_Area, Description: '\n臺北市中山區\n新生北路一段 ' }, { Title: '\r\n ', Description: '' }]) expect(taipeiwater([{ ...row, ...reason }]).items[0]).toMatchObject({ a: '臺北市中山區新生北路一段', r: '', n: 'N1', u: 'https://example.test/N1', t: [['2026-11-02T10:00', '2026-11-02T16:00']] });
  expect(taipeiwater([{ ...row, Title: row.SW_Area, Description: ' 管線汰換\r\n ' }]).items[0].r).toBe('管線汰換');
  expect(taipeiwater([{ ...row, Title: ' 管線汰換 ', Description: '管線汰換\r\n' }]).items[0].r).toBe('管線汰換');
});
it('compresses consecutive daily hours, preserves gaps/different hours and labels overnight hours', () => {
  expect(formatTimes(dailyTimes('115年11月02日~115年11月07日', '10:00~16:00'))).toBe('11/02（一）～11/07（六）每日 10:00–16:00');
  expect(formatTimes([['2026-11-02T10:00', '2026-11-02T16:00'], ['2026-11-04T10:00', '2026-11-04T16:00'], ['2026-11-05T11:00', '2026-11-05T16:00'], ['2026-11-06T23:00', '2026-11-07T01:00']])).toBe('11/02（一）10:00–16:00；11/04（三）10:00–16:00；11/05（四）11:00–16:00；11/06（五）23:00–11/07（六）01:00');
  expect(formatTimes(dailyTimes('115年11月02日~115年11月03日', '23:00~01:00'))).toBe('11/02（一）～11/03（二）每日 23:00–翌日 01:00');
});
it.each(['2026-11-03 09:00:00', '2026/11/03 09:00', '115-11-03 09:00', '115/11/03 09:00', '115年11月03日 09:00', '2026-11-03T01:00:00Z', '2026-11-03T09:00:00+08:00'])('parses %s to Taipei local time', value => { expect(parseDate(value)).toBe('2026-11-03T09:00'); });
it('keeps unknown Taiwan Water times and maps multiple counties/districts with fallback areas', () => {
  const items = taiwater(JSON.parse(fixture('taiwater.json'))).items;
  expect(items.filter(i => i.n === 'W1').map(i => [i.c, i.d])).toEqual([['新北市', '板橋區'], ['桃園市', '桃園區']]); expect(items[0].a).toContain('降壓：文化路二段');
  expect(items.find(i => i.n === 'W2')).toMatchObject({ c: '臺中市', d: '北屯區' }); expect(items.find(i => i.n === 'W3')).toMatchObject({ t: '待確認～另行公告', r: '降壓維護' });
  expect(taiwater([{ 影響縣市: '新北市', 停水地區: '板橋區文化路', 案件日期時間: '115年11月03日 09:00', 恢復日期時間: '2026-11-03 18:00' }]).items[0]).toMatchObject({ c: '新北市', d: '板橋區' });
  expect(() => taiwater(JSON.parse(fixture('empty.json')))).toThrow('空清單'); expect(() => taiwater({})).toThrow('格式錯誤'); expect(parseDate('2026-02-30 09:00')).toBeNull();
});
it('retains explicitly listed districts missing from multi-county area text', () => {
  const items = taiwater([{ 影響縣市: '新北市、桃園市', 影響行政區: '板橋區、中和區、桃園區', 停水地區: '新北市板橋區文化路、桃園市桃園區中正路' }]).items;
  expect(items.map(i => [i.c, i.d])).toEqual([['新北市', '板橋區'], ['新北市', '中和區'], ['桃園市', '桃園區']]);
});
it('rejects malformed snapshots rather than treating them as no announcements', () => {
  expect(() => decodeIndex('{}')).toThrow(); expect(() => decodeShard('[{}]', 'taipower', '臺北市')).toThrow();
  const index = { v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { taipower: { ok: true, counties: { 臺北市: { sha: 'a'.repeat(64), count: 1, writtenAt: 'bad' } } } } };
  expect(() => decodeIndex(JSON.stringify(index))).toThrow('公告縣市格式錯誤'); index.sources.taipower.counties.臺北市.writtenAt = index.generatedAt; expect(decodeIndex(JSON.stringify(index))).toEqual(index);
});

it('infers county only when a known office covers exactly one county with that district', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const csv = [header,
    '台電台中區營業處,H15648,施工,無,無,北屯區東山路一段,1911',
    '台電台中區營業處,missing,施工,無,無,幸福社區中正路,1911',
    '未知處,unknown,施工,無,無,北屯區松竹路,1911',
    '台電台中區營業處,outside,施工,無,無,板橋區一街,1911',
  ].join('\n');
  const result = taipower(new Map([['191.csv', csv]]), 1);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ n: 'H15648', c: '臺中市', d: '北屯區', a: '臺中市北屯區東山路一段' });
  expect(result.dropped).toBe(3);
});
it('validates the optional dropped row count in the index', () => {
  const entry = { ok: true, counties: {}, dropped: 2 };
  const index = { v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { taipower: entry } };
  expect(decodeIndex(JSON.stringify(index)).sources.taipower?.dropped).toBe(2);
  for (const dropped of [-1, 1.5, '2', null]) expect(() => decodeIndex(JSON.stringify({ ...index, sources: { taipower: { ...entry, dropped } } }))).toThrow();
});

it('includes all 368 current districts across the 22 counties with 臺 spelling', () => {
  expect(counties).toHaveLength(22);
  expect(Object.values(districts).flat()).toHaveLength(368);
  expect(Object.fromEntries(Object.entries(districts).map(([c, ds]) => [c, ds.length]))).toEqual({
    臺北市: 12, 新北市: 29, 桃園市: 13, 臺中市: 29, 臺南市: 37, 高雄市: 38,
    基隆市: 7, 新竹市: 3, 嘉義市: 2, 新竹縣: 13, 苗栗縣: 18, 彰化縣: 26,
    南投縣: 13, 雲林縣: 20, 嘉義縣: 18, 屏東縣: 33, 宜蘭縣: 12, 花蓮縣: 13,
    臺東縣: 16, 澎湖縣: 6, 金門縣: 6, 連江縣: 4,
  });
  for (const ds of Object.values(districts)) { expect(new Set(ds).size).toBe(ds.length); expect(ds.join('')).not.toContain('台'); }
  expect(canonical('桃園縣平鎮區')).toBe('桃園市平鎮區');
});
it('uses listed districts at the start of an area rather than community or market words', () => {
  const areas = ['臺北市幸福社區市場', '臺北市市場周邊', '臺北市中山市場旁', '臺北市中山區幸福社區市場', '臺中市新社區中正路'];
  expect(areas.map(locations)).toEqual([
    [{ c: '臺北市', d: '' }], [{ c: '臺北市', d: '' }], [{ c: '臺北市', d: '' }],
    [{ c: '臺北市', d: '中山區' }], [{ c: '臺中市', d: '新社區' }],
  ]);
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  expect(taipower(new Map([['101.csv', [header, ...areas.map((a, i) => `處,${i},施工,無,無,${a},1911`)].join('\n')]]), 1).items.map(i => i.d)).toEqual(['', '', '', '中山區', '新社區']);
});
it('preserves market names in legacy county areas while converting municipality suffixes', () => {
  const areas = ['臺中縣大里市場旁', '臺中縣大里市中興路', '桃園縣桃園市場旁', '桃園縣桃園市中正路'];
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const csv = [header, ...areas.map((area, i) => `處,${i},施工,無,無,${area},1911`)].join('\n');
  expect(taipower(new Map([['101.csv', csv]]), 1).items.map(({ c, d, a }) => [c, d, a])).toEqual([
    ['臺中市', '', '臺中市大里市場旁'], ['臺中市', '大里區', '臺中市大里區中興路'],
    ['桃園市', '', '桃園市桃園市場旁'], ['桃園市', '桃園區', '桃園市桃園區中正路'],
  ]);
});
it('drops wrong-field-count CSV rows and fails only above both the absolute and percentage caps', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const good = '處,good,施工,無,無,臺北市中山區林森北路,1911', bad = '處,bad,施工,無,無,臺北市中山區林森北路';
  const parse = (valid: number, invalid: number) => taipower(new Map([['101.csv', [header, ...Array(valid).fill(good), ...Array(invalid).fill(bad)].join('\n')]]), 1);
  expect(parse(1, 1)).toMatchObject({ rows: 2, dropped: 1, items: [expect.objectContaining({ n: 'good' })] });
  expect(parse(1, 20).dropped).toBe(20);
  expect(parse(420, 21).dropped).toBe(21);
  expect(() => parse(1, 21)).toThrow('資料列過多');
  expect(() => taipower(new Map([['101.csv', header.replace('工作概述', '錯誤欄位') + '\n' + good]]), 1)).toThrow('欄位格式錯誤');
});
it('counts unlocatable notices for both water sources', () => {
  const north = taipeiwater([{ SW_Area: '臺北市中山區林森北路' }, { SW_Area: '文化路' }]);
  const water = taiwater([{ 影響縣市: '雲林縣', 停水地區: '斗六市中山路' }, { 停水地區: '文化路' }]);
  for (const data of [north, water]) { expect(data.rows).toBe(2); expect(data.dropped).toBe(1); expect(data.items).toHaveLength(1); }
});
it('collapses controls and whitespace, preserves full areas and bounds reasons for every source', () => {
  const area = '臺北市中山區林森北路\r\n\t\u0000 一段' + '路'.repeat(220), reason = '管線\n\t\u0007 維修' + '修'.repeat(120);
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const items = [
    ...taipeiwater([{ SW_Area: area, Title: reason }]).items,
    ...taiwater([{ 停水地區: area, 停水原因: reason }]).items,
    ...taipower(new Map([['101.csv', `${header}\n處,1,"${reason}",無,無,"${area}",1911`]]), 1).items,
  ];
  for (const item of items) {
    expect(item.a).toBe('臺北市中山區林森北路 一段' + '路'.repeat(220)); expect(item.r).toHaveLength(100);
    expect(item.a).toContain('林森北路 一段'); expect(item.r).toContain('管線 維修');
    expect(item.r.endsWith('…')).toBe(true);
    expect(item.a + item.r).not.toMatch(/[\r\n\t\u0000\u0007]/);
  }
});

it('resolves every live power office and its covered counties', () => {
  const offices: Record<string, string[]> = {
    基隆: ['基隆市', '新北市'], 台北: ['臺北市', '新北市'], 台北市: ['臺北市'], 台北北: ['臺北市', '新北市'], 台北南: ['臺北市', '新北市'], 台北西: ['臺北市', '新北市'],
    桃園: ['桃園市', '新北市'], 新竹: ['新竹市', '新竹縣', '桃園市'], 苗栗: ['苗栗縣', '臺中市'], 台中: ['臺中市', '南投縣'], 南投: ['南投縣', '臺中市'],
    彰化: ['彰化縣', '南投縣'], 雲林: ['雲林縣', '嘉義縣'], 嘉義: ['嘉義市', '嘉義縣'], 新營: ['臺南市', '嘉義縣'], 台南: ['臺南市'],
    高雄: ['高雄市', '臺南市'], 鳳山: ['高雄市'], 屏東: ['屏東縣'], 台東: ['臺東縣'], 花蓮: ['花蓮縣'], 宜蘭: ['宜蘭縣', '新北市'], 澎湖: ['澎湖縣'], 金門: ['金門縣'],
  };
  for (const [name, expected] of Object.entries(offices)) expect(countiesForOffice(`${name === '金門' ? '' : '台電'}${name}區營業處`)).toEqual(expected);
});
it('validates optional dropped counts by office', () => {
  const entry = { ok: true, counties: {}, droppedBy: { '台電新營區營業處': 2 } };
  const index = { v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { taipower: entry } };
  expect(decodeIndex(JSON.stringify(index)).sources.taipower?.droppedBy).toEqual(entry.droppedBy);
  for (const droppedBy of [null, [], { office: -1 }, { office: 1.5 }, { office: '2' }, { '': 1 }]) expect(() => decodeIndex(JSON.stringify({ ...index, sources: { taipower: { ...entry, droppedBy } } }))).toThrow();
});
it('keeps stray unquoted quotes and drops malformed CSV records while continuing', () => {
  const header = '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)';
  const text = [header, '台電台中區營業處,a,施"工,無,無,北屯區一街,1911', '台電台中區營業處,b,"壞"字,無,無,北屯區二街,1911', '台電新營區營業處,c,"未結束', '台電台中區營業處,d,施工,無,無,北屯區三街,1911'].join('\n');
  const result = taipower(new Map([['101.csv', text]]), 1);
  expect(result.items.map(i => i.n)).toEqual(['a', 'd']); expect(result.items[0].r).toBe('施"工');
  expect(result.dropped).toBe(2); expect(result.droppedBy).toMatchObject({ '台電台中區營業處': 1, '台電新營區營業處': 1 });
});
it('resolves legacy municipality names without changing existing county districts', () => {
  for (const [county, old, expected] of [['新北市', '板橋市', '板橋區'], ['高雄市', '鳳山市', '鳳山區'], ['臺中市', '豐原市', '豐原區'], ['臺南市', '新營市', '新營區'], ['新竹縣', '竹北市', '竹北市'], ['彰化縣', '員林市', '員林市']]) expect(resolveDistrict(county, old)).toBe(expected);
  expect(locations('臺北縣板橋市文化路')).toEqual([{ c: '新北市', d: '板橋區' }]);
});
