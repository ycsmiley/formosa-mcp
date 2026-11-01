import { norm } from '../garbage/text.js';
import { counties, taiwaterEmptyReason } from './normalize.js';
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
function keywordArea(area: string, district: string): string {
  const text = norm(area); if (!district) return text;
  const mentions = [...text.matchAll(/[\u4e00-\u9fff]{1,3}?區|[\u4e00-\u9fff]{1,3}?[鄉鎮市]/g)];
  if (!mentions.some(m => m[0] === district)) return text;
  return mentions.flatMap((m, i) => m[0] === district ? [text.slice(m.index, mentions.slice(i + 1).find(next => next[0] !== district)?.index)] : []).join('；');
}
export function createOutageService(store: OutageStore, clock = () => new Date()) {
  return { async schedule(q: Query): Promise<{ text: string; isError: boolean }> {
    const finish = (lines: string[], isError = false) => ({ text: [...lines, license, reminder].join('\n'), isError });
    const city = counties.find(c => c === norm(q.city) || c.replace(/市$/, '') === norm(q.city));
    if (!city) return finish(['請提供完整臺灣縣市名稱，例如「臺北市」、「雲林縣」。'], true);
    const now = clock(), today = local(now).slice(0, 10), start = q.start_date ?? today, end = q.end_date ?? addDays(today, 6);
    if (!validDay(start) || !validDay(end)) return finish(['日期請使用有效的 YYYY-MM-DD 格式。'], true);
    if (end < start) return finish(['結束日期不可早於開始日期。'], true);
    if ((Date.parse(end) - Date.parse(start)) / 86400000 + 1 > 31) return finish(['查詢日期範圍最多 31 天。'], true);
    const district = norm(q.district ?? ''), keyword = norm(q.keyword ?? ''), type = q.type ?? 'all', place = `${city}${district}`, dates = `${start}～${end}`, kind = type === 'water' ? '停水' : type === 'power' ? '停電' : '停水／停電';
    const lines = [`${place} ${dates} 計畫性${kind}${keyword ? `（關鍵字「${keyword}」）` : ''}`], relevant = relevantSources(city, type);
    if (city === '連江縣' && type !== 'water') lines.push(`台電開放資料未涵蓋連江縣，請至 ${official.taipower.url} 查詢。`);
    let index: Index | null = null;
    try { index = await store.index(relevant); } catch { /* Each relevant source is reported below. */ }
    const results = await Promise.all(relevant.map(async source => {
      const info = index?.sources[source];
      const previousTaiwater = source === 'taiwater' && !info?.ok && info?.reason === taiwaterEmptyReason;
      if ((!info?.ok && !previousTaiwater) || !info?.lastSuccessAt) return { source, info, items: null, reason: info?.reason || '尚無成功取得的資料' };
      if (!Object.hasOwn(info.counties, city)) return { source, info, items: [] as Item[] };
      try { const items = await store.shard(source, city, info.counties[city].sha); if (!items || items.length !== info.counties[city].count) throw Error(); return { source, info, items }; }
      catch { return { source, info, items: null, reason: '縣市公告快照遺失或無法解讀' }; }
    }));
    const matched: Item[] = [], checked: string[] = [], unavailable: string[] = [];
    const endExclusive = `${addDays(end, 1)}T00:00`, startInclusive = `${start}T00:00`;
    const overlaps = ([a, b]: [string, string]) => a < endExclusive && b > startInclusive;
    const stale = results.filter(({ info }) => info?.lastSuccessAt && now.getTime() - Date.parse(info.lastSuccessAt) > 86400000).map(({ source, info }) => `${official[source].name} ${acquired(info!.lastSuccessAt, false)}`);
    if (!stale.length && index && now.getTime() - Date.parse(index.generatedAt) > 86400000) stale.push(acquired(index.generatedAt, false));
    if (stale.length) lines.push(`⚠️ 資料可能過期（最後更新：${stale.join('、')}（臺北時間））`);
    for (const result of results) {
      const { source } = result;
      const emptyTaiwater = source === 'taiwater' && !result.info?.ok && result.info?.reason === taiwaterEmptyReason;
      if (emptyTaiwater) unavailable.push(`台水官方開放資料目前是空的，結果可能不完整，請至 ${official.taiwater.url} 自行查詢。`);
      if (!result.items) { if (!emptyTaiwater) unavailable.push(`${official[source].name}：該來源暫時無法取得（${result.reason}），請至 ${official[source].url} 查詢`); continue; }
      if (result.info?.ok) checked.push(official[source].name);
      matched.push(...result.items.filter(item => item.c === city && (!district || !item.d || norm(item.d) === district) && (!keyword || keywordArea(item.a, district).includes(keyword))).map(item => ({ ...item, t: typeof item.t === 'string' ? item.t : item.t.filter(overlaps) })).filter(item => typeof item.t === 'string' || item.t.length));
    }
    matched.sort((a, b) => (typeof a.t === 'string' ? '\uffff' : a.t[0][0]).localeCompare(typeof b.t === 'string' ? '\uffff' : b.t[0][0]));
    // Multi-district announcements remain a single result when querying the whole county.
    const items = [...new Map(matched.map(item => [JSON.stringify([item.s, item.n, item.t, item.a, item.r, item.u]), item])).values()];
    if (!items.length && checked.length) lines.push(`官方公告中查無 ${place} ${dates} 的計畫性${kind}${keyword ? `（關鍵字「${keyword}」）` : ''}。`, `已查詢來源：${checked.join('、')}。`);
    for (const item of items.slice(0, 30)) {
      lines.push(`${item.k === 'power' ? '🔌 停電' : '💧 停水'}｜${formatTimes(item.t)}`, `範圍：${areaText(item)}${!item.d ? '（未標示行政區）' : ''}`, `原因：${item.r || (item.s === 'taipeiwater' ? '北水公告未提供' : '未提供')}${item.n ? `（${item.k === 'power' ? '請求號數' : '案件編號'} ${item.n}）` : ''}`);
      const info = index?.sources[item.s];
      lines.push(`來源：${item.s === 'taipower' ? item.o || official[item.s].name : official[item.s].name + (item.o ? ` ${item.o}` : '')} ${item.u}${item.k === 'power' ? '｜查詢電話 1911' : ''}｜資料取得 ${acquired(info?.ok ? info.fetchedAt ?? info.lastSuccessAt : info?.lastSuccessAt)}`);
    }
    if (items.length > 30) lines.push(`另有 ${items.length - 30} 筆，請縮小範圍`);
    lines.push(...unavailable);
    return finish(lines);
  } };
}
