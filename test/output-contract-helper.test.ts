import { expect, it } from 'vitest';
import { assertStaleCoverage, deniedKeys, hasDataTime, rawJsonViolations, sourcePattern } from './output-contract-helper.js';
it.each(['2330', '更新時間未提供', '資料日期：1', '18:05', '資料更新中', '查詢 2026-11-02～2026-11-08', '近期除權息（115年11月20日起，列出前 0 筆）'])('rejects meaningless time %s', text => expect(hasDataTime(text)).toBe(false));
it.each(['資料日期：115年10月29日', '資料更新：115年10月23日', '資料更新：2026-10-29 18:19', '【115年07-08月】沒中'])('accepts meaningful data date %s', text => expect(hasDataTime(text)).toBe(true));
it('requires valued attribution and recognizes existing label variants', () => {
  expect('資料來源').not.toMatch(sourcePattern);
  for (const text of ['資料來源：財政部', '來源：台電', '資料介接「交通部TDX平臺」']) expect(text).toMatch(sourcePattern);
});
it.each(['{"Code":"2330"}', '[1,2]', '說明\n```json\n{\n "ClosingPrice": "10"\n}\n```', '文字 [ "2330" ]', 'TrainNo = 149', 'SW_Area = 臺北市', 'garbagemonday = Y'])('rejects upstream JSON/fields: %s', text => expect(rawJsonViolations(text).length).toBeGreaterThan(0));
it('derives representative keys from fixtures and respects whole tokens', () => {
  expect(deniedKeys).toEqual(expect.arrayContaining(['Code', 'ClosingPrice', 'SecuritiesCompanyCode', 'TrainNo', 'StartingStationID', 'StationName', 'DailyTrainInfo', 'SW_Area', 'garbagemonday']));
  expect(rawJsonViolations('名稱與時間皆已格式化；請求號數 T1；SomeTrainNoSuffix；中文name中文')).toEqual([]);
});
it('rejects a new snapshot reader without a stale case or named exemption', () => {
  expect(() => assertStaleCoverage(['existing', 'new_reader'], ['existing'], [], ['existing', 'new_reader'])).toThrow('new_reader needs a stale fixture or named exemption');
});
it('rejects obsolete stale exemptions', () => {
  expect(() => assertStaleCoverage(['existing'], ['existing'], ['removed'], ['existing'])).toThrow('obsolete stale exemption removed');
});
it('rejects a tool with both a warning case and an exemption', () => {
  expect(() => assertStaleCoverage(['existing'], ['existing'], ['existing'], ['existing'])).toThrow('existing has both a stale fixture and an exemption');
});
it('rejects exemption entries that no longer read snapshots', () => {
  expect(() => assertStaleCoverage(['existing'], ['existing'], ['live_only'], ['existing', 'live_only'])).toThrow();
});
