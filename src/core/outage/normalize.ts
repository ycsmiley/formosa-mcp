import { norm, stripZeroWidth } from '../garbage/text.js';
import { official, type Item } from './model.js';
import { counties, districtAtStart, resolveDistrict } from './districts.js';
import { dailyTimes, powerWindow, waterTimes } from './time.js';
export { counties } from './districts.js';
export const clean = (s: unknown, limit = Infinity) => {
  const text = typeof s === 'string' || typeof s === 'number' ? stripZeroWidth(String(s)).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
export const canonical = (s: string) => stripZeroWidth(norm(s))
  .replace(/桃園縣(桃園|中壢|平鎮|八德|楊梅|蘆竹|大溪|龍潭|龜山|大園|觀音|新屋|復興)[市鄉鎮區]/g, '桃園市$1區')
  .replace(/桃園縣/g, '桃園市').replace(/臺北縣/g, '新北市').replace(/(臺中|臺南|高雄)縣/g, '$1市');
const countyPattern = counties.join('|');
export function locations(text: string): { c: string; d: string }[] {
  const area = canonical(text), matches = [...area.matchAll(new RegExp(countyPattern, 'g'))];
  const result = matches.flatMap((m, i) => {
    const c = m[0], section = area.slice(m.index! + c.length, matches[i + 1]?.index);
    const ds = section.split(/[、,，；;/]/).map(part => districtAtStart(c, part.trim())).filter(Boolean);
    return (ds.length ? ds : ['']).map(d => ({ c, d }));
  });
  return result.filter((v, i, all) => all.findIndex(x => x.c === v.c && x.d === v.d) === i);
}
const records = (input: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(input) || input.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw Error('官方開放資料格式錯誤');
  return input;
};
export const taiwaterEmptyReason = '官方開放資料目前回傳空清單';
export function taiwater(input: unknown): { items: Item[]; dropped: number; rows: number } {
  const rows = records(input); if (!rows.length) throw Error(taiwaterEmptyReason);
  const items: Item[] = []; let dropped = 0;
  for (const row of rows) {
    const v = (key: string) => clean(row[key]); const area = [v('停水地區'), v('降壓地區') ? `降壓：${v('降壓地區')}` : ''].filter(Boolean).join('；');
    const explicit = canonical(v('影響縣市')), cs = counties.filter(c => explicit.includes(c));
    const fallback = locations(cs.length === 1 && !counties.some(c => canonical(area).includes(c)) ? cs[0] + area : area); const ds = canonical(v('影響行政區')).split(/[、,，/\s]+/).filter(Boolean);
    const places = cs.length ? cs.flatMap(c => {
      let scoped = ds.filter(d => !counties.some(other => d.includes(other)) || d.includes(c)).map(d => resolveDistrict(c, d.replace(new RegExp(countyPattern, 'g'), ''))).filter((d): d is string => !!d);
      const linked = fallback.filter(p => p.c === c).map(p => p.d).filter(d => scoped.includes(d));
      if (cs.length > 1) scoped = scoped.filter(d => linked.includes(d) || ds.some(raw => raw.includes(c) && raw.replace(new RegExp(countyPattern, 'g'), '') === d) || !fallback.some(p => p.d === d));
      return (scoped.length ? scoped : fallback.filter(p => p.c === c).map(p => p.d)).map(d => ({ c, d })).concat(!scoped.length && !fallback.some(p => p.c === c) ? [{ c, d: '' }] : []);
    }) : fallback;
    if (!places.length) dropped++;
    for (const { c, d } of places) items.push({ s: 'taiwater', k: 'water', c, d, t: waterTimes(v('案件日期時間'), v('恢復日期時間')), a: clean(area, 200), r: clean(v('停水原因') || v('降壓原因'), 100), n: v('案件編號'), u: official.taiwater.url, ...(v('案件類型') ? { o: v('案件類型') } : {}) });
  }
  if (!items.length) throw Error('官方開放資料未提供可辨識的縣市');
  return { items: unique(items), dropped, rows: rows.length };
}
export function taipeiwater(input: unknown): { items: Item[]; dropped: number; rows: number } {
  const items: Item[] = []; const rows = records(input); let dropped = 0;
  for (const row of rows) {
    const v = (key: string) => clean(row[key]);
    const area = v('SW_Area'), same = (s: string) => s.replace(/\s+/g, '');
    const reason = [...new Set([v('Title'), v('Description')].filter(s => s && same(s) !== same(area)))].join('；');
    const places = locations(area); if (!places.length) dropped++;
    for (const { c, d } of places) items.push({ s: 'taipeiwater', k: 'water', c, d, t: dailyTimes(v('Date'), v('Time')), a: clean(area, 200), r: clean(reason, 100), n: v('SW_No'), u: /^https?:\/\//i.test(v('MapUrl')) ? v('MapUrl') : official.taipeiwater.url });
  }
  if (rows.length && !items.length) throw Error('官方開放資料未提供可辨識的縣市');
  return { items: unique(items), dropped, rows: rows.length };
}
function unique(items: Item[]): Item[] { return [...new Map(items.map(i => [JSON.stringify(i), i])).values()]; }
function parseCsv(text: string): string[][] {
  const records: string[][] = []; let record: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (ch === ',' || ch === '\n' || ch === '\r' && text[i + 1] === '\n') {
      record.push(field); field = ''; closed = false;
      if (ch !== ',') { records.push(record); record = []; if (ch === '\r') i++; }
    } else if (ch === '"' || closed) throw Error('台電 CSV 資料格式錯誤');
    else field += ch;
  }
  if (quoted) throw Error('台電 CSV 資料格式錯誤');
  record.push(field); records.push(record); return records;
}
const officeCounties: Record<string, string[]> = {
  臺北市區營業處: ['臺北市'], 臺北區營業處: ['臺北市', '新北市'], 臺北南區營業處: ['臺北市', '新北市'], 臺北西區營業處: ['臺北市', '新北市'],
  基隆區營業處: ['基隆市', '新北市'], 桃園區營業處: ['桃園市'], 新竹區營業處: ['新竹市', '新竹縣'], 苗栗區營業處: ['苗栗縣'],
  臺中區營業處: ['臺中市'], 彰化區營業處: ['彰化縣'], 南投區營業處: ['南投縣'], 雲林區營業處: ['雲林縣'], 嘉義區營業處: ['嘉義市', '嘉義縣'],
  臺南區營業處: ['臺南市'], 新營區營業處: ['臺南市'], 高雄區營業處: ['高雄市'], 鳳山區營業處: ['高雄市'], 屏東區營業處: ['屏東縣'],
  宜蘭區營業處: ['宜蘭縣'], 花蓮區營業處: ['花蓮縣'], 臺東區營業處: ['臺東縣'], 澎湖區營業處: ['澎湖縣'], 金門區營業處: ['金門縣'],
};
export function taipower(files: Map<string, string>, minimum = 100): { items: Item[]; dropped: number; rows: number } {
  const groups = new Map<string, { item: Item; areas: Set<string> }>(); let rows = 0, dropped = 0;
  for (const [code, text] of files) {
    const lines = parseCsv(text.replace(/^\uFEFF/, '').trim());
    const header = lines.shift();
    if (header?.length !== 7 || header.join(',') !== '營業區處,請求號數,工作概述,第一次停電時間,第二次停電時間,停電範圍,查詢電話(1911)') throw Error('台電 CSV 欄位格式錯誤');
    for (const fields of lines) {
      if (fields.length === 1 && !fields[0].trim()) continue; rows++;
      if (fields.length !== 7) { dropped++; continue; }
      const [office, n, r, first, second, area] = fields.map(s => clean(s)); let a = canonical(area);
      let c = counties.find(c => a.startsWith(c));
      if (!c) { const candidates = (officeCounties[canonical(office).replace(/^臺電/, '')] ?? []).filter(county => districtAtStart(county, a)); if (candidates.length === 1) { c = candidates[0]; a = c + a; } }
      if (!c) { dropped++; continue; }
      const d = districtAtStart(c, a.slice(c.length).trimStart());
      const windows = [first, second].filter(s => s && s !== '無'); const parsed = windows.map(powerWindow);
      const t = windows.length && parsed.every(t => t !== null) ? parsed as [string, string][] : windows.join('；') || '未標示時間';
      const key = JSON.stringify([n, t, c, d]); const found = groups.get(key);
      if (found) found.areas.add(a);
      else groups.set(key, { item: { s: 'taipower', k: 'power', c, d, t, a, r: clean(r, 100), n, u: `https://service.taipower.com.tw/branch/d${code.replace(/\.csv$/, '')}`, o: office }, areas: new Set([a]) });
    }
  }
  if (dropped > 20 && dropped / rows > 0.05) throw Error('台電開放資料無法辨識的資料列過多');
  if (rows < minimum || !groups.size) throw Error('台電開放資料筆數不足');
  return { items: [...groups.values()].map(({ item, areas }) => ({ ...item, a: clean([...areas].sort().join('、'), 200) })), dropped, rows };
}
