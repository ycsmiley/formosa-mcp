import { norm, stripZeroWidth, validKeyword } from '../garbage/text.js';
import { canonical, clean, countiesForOffice, taiwaterEmptyReason } from './normalize.js';
import { counties, districts, districtAtStart, resolveDistrict } from './districts.js';
import { official, type Index, type Item, type Source } from './model.js';
import { addDays, formatTimes, local, validDay } from './time.js';
export interface OutageStore { index(relevant?: Source[]): Promise<Index | null>; shard(source: Source, county: string, sha: string): Promise<Item[] | null> }
export interface Query { city: string; district?: string; keyword?: string; type?: 'water' | 'power' | 'all'; start_date?: string; end_date?: string }
export const reminder = '提醒：緊急搶修、事故或颱風造成的停水停電不會事先公告，請以台電 1911、台水 1910、北水 1999（臺北市外 02-27371999）及官方網站為準。';
const license = '資料來源：台水、北水、台電開放資料；政府資料開放授權條款第1版（OGDL-1）。';
export function relevantSources(city: string, type: Query['type'] = 'all'): Source[] {
  return [...(type !== 'power' ? [...(city === '臺北市' || city === '新北市' ? ['taipeiwater' as const] : []), ...(city !== '臺北市' ? ['taiwater' as const] : [])] : []), ...(type !== 'water' && city !== '連江縣' ? ['taipower' as const] : [])];
}
const acquired = (s?: string, zone = true) => s && Number.isFinite(Date.parse(s)) ? `${local(new Date(s)).replace('T', ' ')}${zone ? '（臺北時間）' : ''}` : '未知';
function areaText(item: Item): string {
  if (!item.d) return item.a;
  const prefix = item.c + item.d; let seen = false;
  return item.a.split(/([、；])/).map((part, i) => { if (i % 2) return part; if (!norm(part).startsWith(prefix)) { seen = false; return part; } if (seen) return part.trim().slice(prefix.length); seen = true; return part.trim(); }).join('');
}
function displayArea(item: Item, keyword: string, district: string): string {
  const text = clean(areaText(item)), match = keyword || district;
  const at = match ? norm(text).indexOf(match) : -1;
  if (text.length <= 200 || at < 0 || at + match.length <= 199) return clean(text, 200);
  const start = Math.max(0, Math.min(at - 50, text.length - 198)), end = Math.min(text.length, start + 198);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
function keywordArea(area: string, city: string, district: string): string {
  const text = stripZeroWidth(norm(area)); if (!district) return text;
  let county = city, current = ''; const parts: string[] = [];
  for (const part of text.split(/[、；，,/]/)) {
    const segment = part.trim(), namedCounty = counties.find(c => segment.startsWith(c));
    if (namedCounty) { county = namedCounty; current = ''; }
    current = districtAtStart(county, segment.slice(namedCounty?.length ?? 0).trimStart()) || current;
    if (county === city && current === district) parts.push(part);
  }
  return parts.length ? parts.join('；') : text;
}
export function createOutageService(store: OutageStore, clock = () => new Date()) {
  return { async schedule(q: Query): Promise<{ text: string; isError: boolean }> {
    const finish = (lines: string[], isError = false) => ({ text: [...lines, license, reminder].join('\n'), isError });
    const name = canonical(q.city.replace(/\s+/g, '')), candidates = counties.filter(c => c === name || c === name + '縣' || c === name + '市');
    if (candidates.length > 1) return finish([`請指定${candidates.join('或')}。`]);
    const city = candidates[0];
    if (!city) return finish(['請提供完整臺灣縣市名稱，例如「臺北市」、「雲林縣」。'], true);
    const now = clock(), today = local(now).slice(0, 10), start = q.start_date ?? today, end = q.end_date ?? addDays(today, 6);
    if (!validDay(start) || !validDay(end)) return finish(['日期請使用有效的 YYYY-MM-DD 格式。'], true);
    if (end < start) return finish(['結束日期不可早於開始日期。'], true);
    if ((Date.parse(end) - Date.parse(start)) / 86400000 + 1 > 31) return finish(['查詢日期範圍最多 31 天。'], true);
    const requestedDistrict = canonical((q.district ?? '').replace(/\s+/g, ''));
    const district = requestedDistrict ? resolveDistrict(city, requestedDistrict) : '';
    if (district === undefined || q.district !== undefined && !requestedDistrict) return finish([`${city}請指定有效行政區：${districts[city].join('、')}。`], true);
    const keyword = norm(clean(q.keyword ?? ''));
    if (q.keyword !== undefined && (!validKeyword(keyword) || keyword.length > 100)) return finish(['關鍵字太短或無效，請輸入 2～100 字的里名、路名或地點，勿使用雙引號或反斜線。'], true);
    const type = q.type ?? 'all', place = `${city}${district}`, dates = `${start}～${end}`, kind = type === 'water' ? '停水' : type === 'power' ? '停電' : '停水／停電';
    const lines = [`${place} ${dates} 計畫性${kind}${keyword ? `（關鍵字「${keyword}」）` : ''}`], relevant = relevantSources(city, type);
    if (city === '連江縣' && type !== 'water') lines.push(`台電開放資料未涵蓋連江縣，請至 ${official.taipower.url} 查詢。`);
    let index: Index | null = null;
    try { index = await store.index(relevant); } catch { /* Each relevant source is reported below. */ }
    const results = await Promise.all(relevant.map(async source => {
      const info = index?.sources[source];
      const retained = info?.lastSuccessAt && now.getTime() - Date.parse(info.lastSuccessAt) <= 72 * 3600000;
      if (!info?.lastSuccessAt || !info.ok && !retained) return { source, info, items: null, reason: info?.reason || '尚無成功取得的資料' };
      if (!Object.hasOwn(info.counties, city)) return { source, info, items: [] as Item[] };
      try { const items = await store.shard(source, city, info.counties[city].sha); if (!items || items.length !== info.counties[city].count) throw Error(); return { source, info, items }; }
      catch { return { source, info, items: null, reason: '縣市公告快照遺失或無法解讀' }; }
    }));
    const matched: Item[] = [], checked: string[] = [], unavailable: string[] = [];
    const endExclusive = `${addDays(end, 1)}T00:00`, startInclusive = `${start}T00:00`;
    const overlaps = ([a, b]: [string, string]) => a < endExclusive && b > startInclusive;
    const stale = results.filter(({ info }) => info?.lastSuccessAt && (!info.ok || now.getTime() - Date.parse(info.lastSuccessAt) > 86400000)).map(({ source, info }) => `${official[source].name} ${acquired(info!.lastSuccessAt, false)}`);
    if (!stale.length && index && now.getTime() - Date.parse(index.generatedAt) > 86400000) stale.push(acquired(index.generatedAt, false));
    if (stale.length) lines.push(`⚠️ 資料可能過期（最後更新：${stale.join('、')}（臺北時間））`);
    for (const result of results) {
      const { source } = result;
      const emptyTaiwater = source === 'taiwater' && !result.info?.ok && result.info?.reason === taiwaterEmptyReason;
      if (emptyTaiwater) unavailable.push(`台水官方開放資料目前是空的，結果可能不完整，請至 ${official.taiwater.url} 自行查詢。`);
      if (!result.items) { if (!emptyTaiwater) unavailable.push(`${official[source].name}：該來源暫時無法取得（${result.reason}），請至 ${official[source].url} 查詢`); continue; }
      if (result.info?.ok) checked.push(official[source].name);
      let dropped = result.info?.dropped ?? 0;
      if (source === 'taipower') {
        let attributed = 0, scoped = 0;
        for (const [office, count] of Object.entries(result.info?.droppedBy ?? {})) {
          const covered = countiesForOffice(office);
          if (covered.length) attributed += count;
          if (covered.includes(city)) scoped += count;
        }
        dropped = scoped + Math.max(0, dropped - attributed);
      }
      if (dropped) unavailable.push(`另有 ${dropped} 筆${official[source].name}公告無法判定縣市，未納入比對，請至 ${official[source].url} 確認。`);
      matched.push(...result.items.filter(item => item.c === city && (!district || !item.d || canonical(item.d) === district) && (!keyword || keywordArea(item.a, city, district).includes(keyword))).map(item => ({ ...item, t: typeof item.t === 'string' ? item.t : item.t.filter(overlaps) })).filter(item => typeof item.t === 'string' || item.t.length));
    }
    matched.sort((a, b) => Number(!a.d) - Number(!b.d) || (typeof a.t === 'string' ? '\uffff' : a.t[0][0]).localeCompare(typeof b.t === 'string' ? '\uffff' : b.t[0][0]));
    // Multi-district announcements remain a single result when querying the whole county.
    const items = [...new Map(matched.map(item => [JSON.stringify([item.s, item.n, item.t, item.a, item.r, item.u]), item])).values()];
    const checkedKind = checked.includes(official.taipower.name) ? (checked.length > 1 ? '停水／停電' : '停電') : '停水';
    if (!items.length && checked.length) lines.push(`官方公告中查無 ${place} ${dates} 的計畫性${checkedKind}${keyword ? `（關鍵字「${keyword}」）` : ''}。`, `已查詢來源：${checked.join('、')}。`);
    for (const item of items.slice(0, 30)) {
      lines.push(`${item.k === 'power' ? '🔌 停電' : '💧 停水'}｜${formatTimes(item.t)}`, `範圍：${displayArea(item, keyword, district)}${!item.d ? '（未標示行政區）' : ''}`, `原因：${item.r || (item.s === 'taipeiwater' ? '北水公告未提供' : '未提供')}${item.n ? `（${item.k === 'power' ? '請求號數' : '案件編號'} ${item.n}）` : ''}`);
      const info = index?.sources[item.s];
      lines.push(`來源：${item.s === 'taipower' ? item.o || official[item.s].name : official[item.s].name + (item.o ? ` ${item.o}` : '')} ${item.u}${item.k === 'power' ? '｜查詢電話 1911' : ''}｜資料取得 ${acquired(info?.ok ? info.fetchedAt ?? info.lastSuccessAt : info?.lastSuccessAt)}`);
    }
    if (items.length > 30) lines.push(`另有 ${items.length - 30} 筆，請縮小範圍`);
    lines.push(...unavailable);
    return finish(lines);
  } };
}
