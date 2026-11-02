import { canonical, clean } from '../outage/normalize.js';
import { counties, districts } from '../outage/districts.js';
import { validDay } from '../outage/time.js';
import { object, timestamp, severities, official, safeLink, type Alert, type Dgpa } from './model.js';
export const entities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code: string) => {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (code[0] !== '#') return named[code.toLowerCase()] ?? all;
  const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : +code.slice(1);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
});
const text = (s: string) => clean(entities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '')));
const attr = (s: string, name: string) => entities(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(s)?.slice(1).find(v => v !== undefined) ?? '');
const tag = (s: string, name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}\\s*>`, 'i').exec(s)?.[1] ?? '';
const tags = (s: string, name: string) => [...s.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}\\s*>`, 'gi'))].map(m => m[1]);
export function ncdrTime(s: string): string | undefined {
  if (timestamp(s)) return s;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(上午|下午)\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m || +m[5] < 1 || +m[5] > 12 || +m[6] > 59 || +m[7] > 59) return;
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (!validDay(day)) return;
  return `${day}T${String(+m[5] % 12 + (m[4] === '下午' ? 12 : 0)).padStart(2, '0')}:${m[6]}:${m[7]}+08:00`;
}
export function parseDgpa(html: string): Dgpa & { updatedAt: string } {
  const header = [...html.matchAll(/<div\b([^>]*)>/gi)].find(m => attr(m[1], 'class').split(/\s+/).includes('Header_YMD'));
  const date = header && /^(\d{2,3})年\s*(\d{1,2})月\s*(\d{1,2})日\s*天然災害停止上班及上課情形$/.exec(text(html.slice(header.index! + header[0].length).split(/<\/div\s*>/i)[0]));
  const update = /更新時間\s*[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d\d):(\d\d):(\d\d)/.exec(text(html));
  if (!date || !update) throw Error('人事行政總處頁面日期或更新時間無法辨識');
  const pageDate = `${+date[1] + 1911}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`, updatedAt = `${update[1]}-${update[2].padStart(2, '0')}-${update[3].padStart(2, '0')}T${update[4]}:${update[5]}:${update[6]}+08:00`;
  if (!validDay(pageDate) || !timestamp(updatedAt)) throw Error('人事行政總處日期無效');
  const body = [...html.matchAll(/<tbody\b([^>]*)>([\s\S]*?)<\/tbody\s*>/gi)].find(m => attr(m[1], 'class').split(/\s+/).includes('Table_Body'))?.[2];
  if (!body) throw Error('人事行政總處缺少 Table_Body');
  const result: Dgpa & { updatedAt: string } = { updatedAt, pageDate, layout: 'flat', noEvent: false, counties: {} };
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  if (body.replace(/<!--[\s\S]*?-->/g, '').replace(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi, '').trim()) throw Error('人事行政總處表格有未辨識內容');
  for (const [i, row] of rows.entries()) {
    const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td\s*>/gi)];
    if (row[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<td\b[^>]*>[\s\S]*?<\/td\s*>/gi, '').trim()) throw Error('人事行政總處表格列無法辨識');
    if (i === rows.length - 1 && cells.length === 1 && attr(cells[0][1], 'colspan') === '3' && /^(?:備註[：:]\s*)?1\.若欲進入本總處網站/.test(text(cells[0][2]))) continue;
    if (cells.some(c => /\bcity_Region\b/.test(attr(c[1], 'headers')))) result.layout = 'regional';
    const data = cells.filter(c => !/\bcity_Region\b/.test(attr(c[1], 'headers')));
    if (data.length === 1 && /\bcity_Name\b/.test(attr(data[0][1], 'headers')) && attr(data[0][1], 'colspan') === '2' && text(data[0][2]) === '無停班停課訊息。' && !result.noEvent) { result.noEvent = true; continue; }
    if (data.length !== 2 || !/\bcity_Name\b/.test(attr(data[0][1], 'headers'))) throw Error('人事行政總處表格列無法辨識');
    const county = canonical(text(data[0][2]));
    const lines = data[1][2].split(/<br\b[^>]*>/i).map(v => clean(text(v), 300)).filter(Boolean);
    if (!counties.includes(county) || Object.hasOwn(result.counties, county) || !lines.length || lines.length > 20) throw Error('人事行政總處縣市或公告列無法辨識');
    result.counties[county] = lines;
  }
  if (result.noEvent ? Object.keys(result.counties).length > 0 : !Object.keys(result.counties).length) throw Error('人事行政總處公告內容矛盾或空白');
  if (result.noEvent) result.layout = 'none';
  return result;
}
export class LoginRequired extends Error { constructor() { super('請先登入會員。'); } }
function warning(s: string) { if (s.includes('請先登入會員')) throw new LoginRequired(); if (/WarningMessage|"Warning"\s*:/i.test(s)) throw Error('NCDR 來源回傳警告'); }
// No DOM or Node dependency: validate nesting before extracting the small Atom/CAP vocabulary.
function xml(s: string, root: string) {
  warning(s);
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw Error('NCDR XML 格式錯誤');
  const stack: string[] = []; let roots = 0, end = 0;
  const input = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '');
  for (const m of input.matchAll(/<([^>]+)>/g)) {
    const between = input.slice(end, m.index);
    if (between.includes('<') || !stack.length && between.trim()) throw Error('NCDR XML 格式錯誤');
    end = m.index! + m[0].length;
    const t = m[1], name = /^\/?([\w:.-]+)/.exec(t)?.[1]; if (!name) throw Error('NCDR XML 格式錯誤');
    if (t[0] === '/') { if (stack.pop() !== name) throw Error('NCDR XML 格式錯誤'); }
    else { if (!stack.length) { if (name.split(':').pop() !== root || roots++) throw Error('NCDR XML 格式錯誤'); } if (!/\/\s*$/.test(t)) stack.push(name); }
  }
  if (!roots || stack.length || input.slice(end).trim() || !new RegExp(`<(?:[\\w-]+:)?${root}\\b`).test(input) || input.replace(/<[^>]+>/g, '').includes('<')) throw Error('NCDR XML 格式錯誤');
}
export interface FeedEntry extends Alert { status: string; msgType: string }
export interface Feed { updated: string; entries: FeedEntry[] }
let mentionPattern: RegExp | undefined;
let mentionOwners: Map<string, string>;
function mentioned(s: string): string[] {
  if (!mentionPattern) {
    // Build once per isolate; ambiguity includes stems shared by different suffixes.
    const owners = new Map<string, Set<string>>();
    for (const [county, names] of Object.entries(districts)) for (const name of names) {
      const full = canonical(name), stem = full.replace(/[鄉鎮市區]$/, '');
      for (const key of [full, ...(stem.length >= 2 ? [stem] : [])]) {
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key)!.add(county);
      }
    }
    mentionOwners = new Map([...owners].filter(([, cs]) => cs.size === 1).map(([name, cs]) => [name, [...cs][0]]));
    for (const county of counties) mentionOwners.set(county, county);
    mentionPattern = new RegExp([...mentionOwners.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');
  }
  const matched = new Set<string>();
  for (const match of canonical(s).matchAll(mentionPattern)) matched.add(mentionOwners.get(match[0])!);
  return counties.filter(c => matched.has(c));
}
function entry(v: Record<string, any>, retainedIds?: ReadonlySet<string>): FeedEntry {
  if (typeof v.id !== 'string' || !v.id || typeof v.title !== 'string' || !v.title || (v.summary !== undefined && typeof v.summary !== 'string' && (!object(v.summary) || typeof v.summary['#text'] !== 'string')) || typeof v.status !== 'string' || typeof v.msgType !== 'string') throw Error('NCDR 告警項目格式錯誤');
  const summary = text(typeof v.summary === 'string' ? v.summary : v.summary?.['#text'] ?? '');
  const links = Array.isArray(v.link) ? v.link : [v.link], link = links.find(l => object(l) && typeof l['@href'] === 'string' && l['@href'].includes('.cap'))?.['@href'] ?? links.find(l => object(l) && typeof l['@href'] === 'string')?.['@href'];
  if (!link || !/^https?:\/\//.test(link)) throw Error('NCDR 告警連結格式錯誤');
  const effective = v.effective ? ncdrTime(v.effective) : undefined, expires = v.expires ? ncdrTime(v.expires) : undefined;
  if (v.effective && !effective || v.expires && !expires) throw Error('NCDR 告警時間格式錯誤');
  return { id: v.id, type: clean(v.category?.['@term'] || v.title, 40), title: clean(v.title, 200), sender: clean(v.author?.name, 100), ...(effective ? { effective } : {}), ...(expires ? { expires } : {}), counties: retainedIds?.has(v.id) ? [] : mentioned(summary), text: clean(summary, 400), link: safeLink(link), detail: false, complete: false, status: v.status, msgType: v.msgType };
}
function feed(updated: unknown, entries: FeedEntry[], now?: Date): Feed {
  if (!timestamp(updated)) throw Error('NCDR 缺少有效來源更新時間');
  if (now && Date.parse(updated as string) - now.getTime() > 5 * 60000) throw Error('NCDR 資料時間異常');
  if (now && now.getTime() - Date.parse(updated as string) > 24 * 3600000) throw Error('NCDR 來源更新時間已超過 24 小時');
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw Error('NCDR 告警識別碼重複');
  return { updated: updated as string, entries: entries.filter(e => e.status === 'Actual' && e.msgType !== 'Cancel') };
}
export function parseNcdrJson(s: string, now?: Date, retainedIds?: ReadonlySet<string>): Feed {
  warning(s); const v: unknown = JSON.parse(s);
  if (!object(v) || typeof v.id !== 'string' || !v.id.trim() || typeof v.title !== 'string' || !v.title.trim() || v.author?.name !== 'NCDR' || v.entry !== undefined && v.entry !== null && !Array.isArray(v.entry) && !object(v.entry)) throw Error('NCDR feed 格式錯誤');
  const entries = v.entry == null ? [] : Array.isArray(v.entry) ? v.entry : [v.entry];
  if (entries.some(e => !object(e))) throw Error('NCDR 告警格式錯誤');
  return feed(v.updated, entries.map(e => entry(e, retainedIds)), now);
}
export function parseNcdrAtom(s: string, now?: Date, retainedIds?: ReadonlySet<string>): Feed {
  xml(s, 'feed'); const body = tag(s, 'feed'), entries = tags(body, 'entry');
  if ([...body.matchAll(/<(?:[\w-]+:)?entry\b/gi)].length !== entries.length) throw Error('NCDR 告警格式錯誤');
  const header = body.replace(/<(?:[\w-]+:)?entry\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?entry\s*>/gi, '');
  if (!text(tag(header, 'id')) || !text(tag(header, 'title')) || text(tag(tag(header, 'author'), 'name')) !== 'NCDR') throw Error('NCDR feed 格式錯誤');
  return feed(text(tag(header, 'updated')), entries.map(e => entry({ id: text(tag(e, 'id')), title: text(tag(e, 'title')), author: { name: text(tag(tag(e, 'author'), 'name')) }, summary: { '#text': tag(e, 'summary') }, link: [...e.matchAll(/<link\b([^>]*)\/?\s*>/gi)].map(m => ({ '@href': attr(m[1], 'href') })), category: { '@term': attr(/<category\b([^>]*)/i.exec(e)?.[1] ?? '', 'term') }, status: text(tag(e, 'status')), msgType: text(tag(e, 'msgType')), effective: text(tag(e, 'effective')), expires: text(tag(e, 'expires')) }, retainedIds)), now);
}
const geocodeCounties: Record<string, string> = {
  '10002': '宜蘭縣', '10004': '新竹縣', '10005': '苗栗縣', '10007': '彰化縣', '10008': '南投縣', '10009': '雲林縣', '10010': '嘉義縣', '10013': '屏東縣', '10014': '臺東縣', '10015': '花蓮縣', '10016': '澎湖縣', '10017': '基隆市', '10018': '新竹市', '10020': '嘉義市', '09007': '連江縣', '09020': '金門縣',
  '63': '臺北市', '64': '高雄市', '65': '新北市', '66': '臺中市', '67': '臺南市', '68': '桃園市',
};
function geocodeCounty(value: string): string | undefined {
  if (!/^\d+$/.test(value)) return;
  return geocodeCounties[value.slice(0, 5)] ?? geocodeCounties[value.slice(0, 2)];
}
export interface Cap extends Omit<Alert, 'link' | 'detail'> { status: string; msgType: string; onset?: string; web?: string }
export function parseCap(s: string): Cap {
  xml(s, 'alert'); const body = tag(s, 'alert'), info = tags(body, 'info').find(i => /^zh/i.test(text(tag(i, 'language')))) || tag(body, 'info');
  const id = text(tag(body, 'identifier')), type = text(tag(info, 'event')), severity = text(tag(info, 'severity'));
  if (!id || !type || !severities.includes(severity as typeof severities[number]) || !text(tag(body, 'status')) || !text(tag(body, 'msgType'))) throw Error('CAP 內容格式錯誤');
  const times: { effective?: string; onset?: string; expires?: string } = {};
  for (const key of ['effective', 'onset', 'expires'] as const) { const v = text(tag(info, key)); if (v && !timestamp(v)) throw Error('CAP 時間格式錯誤'); if (v) times[key] = v; }
  const allAreas = tags(info, 'area').map(area => {
    const original = text(tag(area, 'areaDesc')), matched = new Set(counties.filter(c => canonical(original).startsWith(c)));
    for (const geocode of tags(area, 'geocode')) {
      if (text(tag(geocode, 'valueName')) !== 'Taiwan_Geocode_103') continue;
      const county = geocodeCounty(text(tag(geocode, 'value')));
      if (county) matched.add(county);
    }
    return { original, counties: counties.filter(c => matched.has(c)) };
  });
  const matched = counties.filter(c => allAreas.some(a => a.counties.includes(c)));
  // Keep parallel area/county arrays bounded; derive coverage before display truncation.
  const storedAreas = allAreas.filter(a => a.original && a.counties.length).slice(0, 200);
  const areas = storedAreas.map(a => clean(a.original, 100)), areaCounties = storedAreas.map(a => a.counties);
  const parameters = Object.fromEntries(tags(info, 'parameter').map(p => [text(tag(p, 'valueName')), text(tag(p, 'value'))]));
  return { id, type: clean(type, 40), title: clean(text(tag(info, 'headline')), 200), sender: clean(text(tag(info, 'senderName')), 100), complete: allAreas.length > 0 && allAreas.every(a => a.counties.length > 0), severity: severity as typeof severities[number], ...times, ...(parameters.severity_level ? { level: clean(parameters.severity_level, 60) } : {}), ...(parameters.alert_color ? { color: clean(parameters.alert_color, 20) } : {}), counties: matched, areas, areaCounties, text: clean(text(tag(info, 'description')), 400), web: text(tag(info, 'web')) || official.ncdr, status: text(tag(body, 'status')), msgType: text(tag(body, 'msgType')) };
}
