import { norm } from '../garbage/text.js';
import { official, type Item } from './model.js';
import { dailyTimes, powerWindow, waterTimes } from './time.js';
export const counties = ['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
const clean = (s: unknown) => typeof s === 'string' || typeof s === 'number' ? String(s).trim() : '';
const canonical = (s: string) => norm(s).replaceAll('桃園縣', '桃園市');
const countyPattern = counties.join('|');
export function locations(text: string): { c: string; d: string }[] {
  const result: { c: string; d: string }[] = []; let c = '';
  for (const m of canonical(text).matchAll(new RegExp(`(${countyPattern})|([\\u4e00-\\u9fff]{1,3}?[區鄉鎮市])`, 'g'))) {
    if (m[1]) { c = m[1]; result.push({ c, d: '' }); }
    else if (c) { const previous = result[result.length - 1]; if (previous.c === c && !previous.d) previous.d = m[2]; else result.push({ c, d: m[2] }); }
  }
  return result.filter((v, i, all) => all.findIndex(x => x.c === v.c && x.d === v.d) === i);
}
const records = (input: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(input) || input.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw Error('官方開放資料格式錯誤');
  return input;
};
export function taiwater(input: unknown): Item[] {
  const rows = records(input); if (!rows.length) throw Error('官方開放資料目前回傳空清單');
  const items: Item[] = [];
  for (const row of rows) {
    const v = (key: string) => clean(row[key]); const area = [v('停水地區'), v('降壓地區') ? `降壓：${v('降壓地區')}` : ''].filter(Boolean).join('；');
    const explicit = canonical(v('影響縣市')), cs = counties.filter(c => explicit.includes(c));
    const fallback = locations(cs.length === 1 && !counties.some(c => canonical(area).includes(c)) ? cs[0] + area : area); const ds = canonical(v('影響行政區')).split(/[、,，/\s]+/).filter(Boolean);
    const places = cs.length ? cs.flatMap(c => {
      let scoped = ds.filter(d => !counties.some(other => d.includes(other)) || d.includes(c)).map(d => d.replace(new RegExp(countyPattern, 'g'), '')).filter(Boolean);
      const linked = fallback.filter(p => p.c === c).map(p => p.d).filter(d => scoped.includes(d));
      if (cs.length > 1) scoped = scoped.filter(d => linked.includes(d) || ds.some(raw => raw.includes(c) && raw.replace(new RegExp(countyPattern, 'g'), '') === d) || !fallback.some(p => p.d === d));
      return (scoped.length ? scoped : fallback.filter(p => p.c === c).map(p => p.d)).map(d => ({ c, d })).concat(!scoped.length && !fallback.some(p => p.c === c) ? [{ c, d: '' }] : []);
    }) : fallback;
    for (const { c, d } of places) items.push({ s: 'taiwater', k: 'water', c, d, t: waterTimes(v('案件日期時間'), v('恢復日期時間')), a: area, r: v('停水原因') || v('降壓原因'), n: v('案件編號'), u: official.taiwater.url, ...(v('案件類型') ? { o: v('案件類型') } : {}) });
  }
  if (!items.length) throw Error('官方開放資料未提供可辨識的縣市');
  return unique(items);
}
export function taipeiwater(input: unknown): Item[] {
  const items: Item[] = []; const rows = records(input);
  for (const row of rows) {
    const v = (key: string) => clean(row[key]);
    const area = v('SW_Area'), same = (s: string) => s.replace(/\s+/g, '');
    const reason = [...new Set([v('Title'), v('Description')].filter(s => s && same(s) !== same(area)))].join('；');
    for (const { c, d } of locations(area)) items.push({ s: 'taipeiwater', k: 'water', c, d, t: dailyTimes(v('Date'), v('Time')), a: area, r: reason, n: v('SW_No'), u: /^https?:\/\//i.test(v('MapUrl')) ? v('MapUrl') : official.taipeiwater.url });
  }
  if (rows.length && !items.length) throw Error('官方開放資料未提供可辨識的縣市');
  return unique(items);
}
function unique(items: Item[]): Item[] { return [...new Map(items.map(i => [JSON.stringify(i), i])).values()]; }
export function taipower(files: Map<string, string>, minimum = 100): { items: Item[]; dropped: number; rows: number } {
  const groups = new Map<string, { item: Item; areas: Set<string> }>(); let rows = 0, dropped = 0;
  for (const [code, text] of files) {
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.shift() !== '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)') throw Error('台電 CSV 欄位格式錯誤');
    for (const line of lines) {
      if (!line.trim()) continue; rows++;
      const fields = line.split(','); if (fields.length !== 7) throw Error('台電 CSV 資料格式錯誤');
      const [office, n, r, first, second, area] = fields.map(s => s.trim()); const a = canonical(area);
      const c = counties.find(c => a.startsWith(c)); if (!c) { dropped++; continue; }
      const d = /^([\u4e00-\u9fff]{1,3}?[區鄉鎮市])/.exec(a.slice(c.length))?.[1] ?? '';
      const windows = [first, second].filter(s => s && s !== '無'); const parsed = windows.map(powerWindow);
      const t = windows.length && parsed.every(t => t !== null) ? parsed as [string, string][] : windows.join('；') || '未標示時間';
      const key = JSON.stringify([n, t, c, d]); const found = groups.get(key);
      if (found) found.areas.add(a);
      else groups.set(key, { item: { s: 'taipower', k: 'power', c, d, t, a, r, n, u: `https://service.taipower.com.tw/branch/d${code.replace(/\.csv$/, '')}`, o: office }, areas: new Set([a]) });
    }
  }
  if (rows < minimum || !groups.size) throw Error('台電開放資料筆數不足');
  return { items: [...groups.values()].map(({ item, areas }) => ({ ...item, a: [...areas].sort().join('、') })), dropped, rows };
}
