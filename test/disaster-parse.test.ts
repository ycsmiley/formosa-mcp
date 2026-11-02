import { expect, it } from 'vitest';
import { parseDgpa, parseNcdrJson, parseNcdrAtom, parseCap, ncdrTime, LoginRequired } from '../src/core/disaster/parse.js';
import { decodeIndex, decodeDgpa, decodeAlerts } from '../src/core/disaster/model.js';
import { fixture, htmlFiles, none, json, atom, wind, reservoir, at, index, state } from './disaster-fixtures.js';
it.each(htmlFiles)('parses official DGPA layout %s', file => {
  const value = parseDgpa(fixture(file));
  const expected = file.includes('no-event') ? ['none', 0] : file.includes('1856') ? ['regional', 22] : file.includes('partial') ? ['flat', 4] : file.includes('08-25') ? ['flat', 6] : ['flat', 22];
  expect([value.layout, Object.keys(value.counties).length]).toEqual(expected);
  expect(value.updatedAt).toMatch(/^2026-.*\+08:00$/);
  const { updatedAt: _, ...shard } = value; expect(decodeDgpa(JSON.stringify(shard))).toEqual(shard);
  if (file.includes('08-25')) {
    expect(value.counties['花蓮縣']).toEqual(['今天照常上班、照常上課。', '秀林鄉銅門部落(銅門村7~14鄰):今天停止上班、停止上課。']);
    expect(value.counties['高雄市']).toHaveLength(5); expect(value.counties['高雄市'][4]).toBe('那瑪夏區:今天停止上班、停止上課。');
  }
  if (file.includes('1856')) { expect(value.counties['臺北市']).toEqual(['尚未宣布消息']); expect(Object.values(value.counties).flat().some(s => s.startsWith('明天停止上班'))).toBe(true); expect(value.counties['桃園市'][1]).toBe('復興區立幼兒園華陵分班:今天中午12:00起照常上班、停止上課。'); }
  if (file.includes('saturday')) expect(Object.values(value.counties).flat().join()).toMatch(/(?:已達|未達)停止上班及上課標準/);
});
const countyRow = `<TR><TD headers='city_Name'>臺北市</TD><TD>今天停止上班、停止上課。</TD></TR>`;
it.each([
  none.replace('無停班停課訊息。', '未知格式'), none.replace('更新時間：', '上次更新：'), none.replace('Table_Body"', 'Other_Body"'),
  none.replace('</TBODY>', countyRow + '</TBODY>'), none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, countyRow.replace('臺北市', '火星市')),
  none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, '<tr><td>來源維護中</td></tr>'),
  none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, countyRow + countyRow),
  none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, countyRow.replace('今天停止上班、停止上課。', '')),
  none.replace('2026/11/02 08:58:16', '2026/02/30 08:58:16'),
])('rejects unrecognized DGPA data %#', html => { expect(() => parseDgpa(html)).toThrow(); });
it('accepts mixed case, quoted attributes, entities and canonical county keys without changing original lines', () => {
  const html = none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, countyRow.replace('臺北市', '台北市').replace('今天停止上班、停止上課。', '今天&nbsp;停止上班&#12289;停止上課。'));
  expect(parseDgpa(html).counties['臺北市']).toEqual(['今天 停止上班、停止上課。']);
});
it('parses JSON singleton, array and valid empty feeds; Atom entries match JSON', () => {
  const value = JSON.parse(json); const parsed = parseNcdrJson(json, new Date(at));
  expect(parsed.entries).toHaveLength(3); expect(parseNcdrAtom(atom).entries).toEqual(parsed.entries);
  expect(parseNcdrJson(JSON.stringify({ ...value, entry: value.entry[0] })).entries).toHaveLength(1);
  for (const entry of [undefined, null, []]) expect(parseNcdrJson(JSON.stringify({ ...value, entry })).entries).toEqual([]);
  for (const change of [{ status: 'Test' }, { msgType: 'Cancel' }]) expect(parseNcdrJson(JSON.stringify({ ...value, entry: { ...value.entry[0], ...change } })).entries).toEqual([]);
});
it('recognizes login walls, warning/429 payloads, stale/missing updated and malformed XML', () => {
  for (const parse of [parseNcdrJson, parseNcdrAtom]) {
    expect(() => parse('<WarningMessage><Warning>請先登入會員。</Warning></WarningMessage>')).toThrow(LoginRequired);
    expect(() => parse('{"Warning":"限制存取間隔時間為3秒"}')).toThrow();
    expect(() => parse('<WarningMessage><Warning>failure</Warning></WarningMessage>')).toThrow();
  }
  expect(() => parseNcdrJson(json, new Date('2026-11-02T10:42:00+08:00'))).toThrow('90 分鐘');
  expect(() => parseNcdrAtom(atom, new Date('2026-11-02T10:32:00+08:00'))).toThrow('90 分鐘');
  expect(() => parseNcdrJson(json.replace(/"updated":"[^"]+",/, ''))).toThrow();
  expect(() => parseNcdrAtom(atom.replace('</entry>', '</oops>'))).toThrow();
  expect(() => parseNcdrJson('{"updated":"2026-11-02T09:11:00+08:00"}')).toThrow();
});
it.each([['上午 12:03:00', '00:03:00'], ['下午 12:03:00', '12:03:00'], ['下午 11:00:00', '23:00:00'], ['上午 04:27:00', '04:27:00']])('converts localized NCDR time %s', (value, expected) => { expect(ncdrTime(`2026/11/2 ${value}`)).toBe(`2026-11-02T${expected}+08:00`); });
it.each(['2026/2/30 上午 01:00:00', '2026/11/2 下午 13:00:00', '2026/11/2 上午 00:00:00', 'bad', '2026/11/2 下午 11:99:00'])('rejects invalid time %s', value => { expect(ncdrTime(value)).toBeUndefined(); });
it('parses CAP authority, severity, parameters, counties beyond the first 30 areas and XML entities', () => {
  const w = parseCap(wind), r = parseCap(reservoir);
  expect(w).toMatchObject({ severity: 'Moderate', level: '強風黃色燈號', color: '黃色', onset: '2026-11-02T05:00:00+08:00' });
  expect(w.areas).toHaveLength(30); expect(w.counties).toContain('連江縣');
  expect(r).toMatchObject({ severity: 'Minor', level: '一級警戒', expires: '2026-11-02T11:18:40+08:00', counties: ['雲林縣', '嘉義縣'] });
  expect(parseCap(reservoir.replace('自由溢流</headline>', 'A &amp; B</headline>')).title).toContain('A & B');
});
it('strictly decodes indexes and both shards', () => {
  const valid = index({ dgpa: state() }); expect(decodeIndex(JSON.stringify(valid))).toEqual(valid);
  for (const value of [{ ...valid, writer: 'unknown' }, index({ dgpa: state({ sha: 'x' }) }), index({ ncdr: state({ count: -1 }) }), index({ ncdr: state({ ok: true, closed: true }) }), index({ dgpa: state({ lastSuccessAt: 'bad' }) })]) expect(() => decodeIndex(JSON.stringify(value))).toThrow();
  expect(decodeAlerts('[]')).toEqual([]);
  const { status: _, msgType: __, ...alert } = parseNcdrJson(json).entries[0]; expect(decodeAlerts(JSON.stringify([alert]))).toEqual([alert]);
  for (const patch of [{ counties: ['火星市'] }, { severity: 'disaster' }, { expires: 'bad' }, { text: 'x'.repeat(401) }, { detail: 1 }]) expect(() => decodeAlerts(JSON.stringify([{ ...alert, ...patch }]))).toThrow();
  expect(() => decodeDgpa('{"pageDate":"2026-11-02","layout":"none","noEvent":false,"counties":{}}')).toThrow();
});
it('parses largest DGPA + JSON + CAP well below 2ms per bundle (200 iterations)', () => {
  const largest = htmlFiles.map(fixture).sort((a, b) => b.length - a.length)[0];
  for (let i = 0; i < 10; i++) { parseDgpa(largest); parseNcdrJson(json); parseCap(wind); }
  const start = performance.now(); for (let i = 0; i < 200; i++) { parseDgpa(largest); parseNcdrJson(json); parseCap(wind); }
  expect((performance.now() - start) / 200).toBeLessThan(2);
});
