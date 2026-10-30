import type { City, Slot } from './normalize.js';
import type { Index, Shard } from './snapshot.js';
import { norm } from './text.js';
export interface GarbageStore { index(city?: City): Promise<Index | null>; shard(city: City, gen: string, district: string, keyword: string): Promise<Shard | null> }
export interface Query { city: string; district?: string; keyword?: string; weekday?: string; time?: string }
const cities: Record<City, { name: string; source: string }> = {
  ntpc: { name: '新北市', source: '新北市政府環境保護局「新北市垃圾車路線」' },
  taipei: { name: '臺北市', source: '臺北市政府環境保護局「臺北市垃圾車點位路線資訊」' },
  taichung: { name: '臺中市', source: '臺中市政府環境保護局「臺中市定時定點垃圾收運地點」' },
  tainan: { name: '臺南市', source: '臺南市政府環境保護局「臺南市垃圾清運點資料」' },
  kaohsiung: { name: '高雄市', source: '高雄市政府環境保護局「垃圾車到點時間預估」' },
};
const day = (date: Date) => new Date(date.getTime() + 8 * 3600000).getUTCDay();
const dayNames = '日一二三四五六';
function weekday(s: string | undefined, now: Date): number | undefined {
  if (!s) return undefined;
  if (s === '今天') return day(now);
  if (s === '明天') return (day(now) + 1) % 7;
  const value = s.replace(/^(?:星期|禮拜|週)/, '').replace('天', '日');
  const i = dayNames.indexOf(value); return value.length === 1 && i >= 0 ? i : undefined;
}
export function createGarbageService(store: GarbageStore, clock = () => new Date()) {
  return { async schedule(q: Query): Promise<{ text: string; isError: boolean }> {
    const city = (Object.keys(cities) as City[]).find(c => norm(cities[c].name).replace(/市$/, '') === norm(q.city).replace(/市$/, ''));
    if (!city) return { text: `目前支援新北市、臺北市、臺中市、臺南市、高雄市；「${q.city}」尚未支援。`, isError: false };
    try {
      const index = await store.index(city); const info = index?.cities[city];
      if (!info) return { text: '資料更新中，請稍後再試', isError: true };
      const districts = Object.keys(info.districts); let keyword = norm(q.keyword ?? '');
      let district = q.district ? districts.find(d => norm(d).replace(/區$/, '') === norm(q.district!).replace(/區$/, '')) : undefined;
      if (!q.district) {
        for (const d of [...districts].sort((a, b) => b.length - a.length)) {
          const full = norm(d), short = full.replace(/區$/, '');
          const pos = keyword.indexOf(full);
          if (pos === 0 || (pos > 0 && /[\s\p{P}]/u.test(keyword[pos - 1]) && (pos + full.length === keyword.length || /[\s\p{P}]/u.test(keyword[pos + full.length])))) { district = d; keyword = (keyword.slice(0, pos) + keyword.slice(pos + full.length)).trim(); break; }
          if (short.length >= 2 && keyword.startsWith(short)) { district = d; keyword = keyword.slice(short.length).trim(); break; }
        }
      }
      if (!district) return { text: `${cities[city].name}請指定行政區：${districts.join('、')}。`, isError: false };
      if (!keyword) return { text: '請提供里名、路名或地點關鍵字，例如「板橋 文化路」。', isError: false };
      if ([...keyword].length < 2 || /^[\p{N}]+$/u.test(keyword) || /^[\p{P}\p{S}\s]+$/u.test(keyword)) return { text: '關鍵字太短或無效，請至少輸入兩個字的里名、路名或地點，例如「文化路」。', isError: false };
      const now = clock(), wantedDay = weekday(q.weekday, now);
      if (q.weekday && wantedDay === undefined) return { text: '請輸入今天、明天或星期一至星期日。', isError: true };
      if (city === 'taipei' && (wantedDay === 3 || wantedDay === 0)) return { text: '臺北市週三、週日停收垃圾、資源回收及廚餘（環保局週收五日規則）。\n實際收運以各地環保局公告為準（國定假日可能調整）', isError: false };
      const shard = await store.shard(city, info.gen, district, keyword);
      if (!shard) return { text: now.getTime() - Date.parse(info.fetchedAt) > 14 * 86400000 ? '垃圾車資料已過時，請稍後再試。' : '資料更新中，請稍後再試', isError: true };
      if (city === 'kaohsiung' && wantedDay !== undefined) {
        const capture = new Date(Date.parse(info.fetchedAt) + 8 * 3600000);
        const today = new Date(now.getTime() + 8 * 3600000);
        const requested = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + (wantedDay - today.getUTCDay() + 7) % 7));
        if (capture.toISOString().slice(0, 10) !== requested.toISOString().slice(0, 10)) {
          return { text: `高雄市資料只含 ${capture.getUTCMonth() + 1}/${capture.getUTCDate()}（星期${dayNames[capture.getUTCDay()]}）當日班表，無法查詢 ${requested.getUTCMonth() + 1}/${requested.getUTCDate()}（星期${dayNames[wantedDay]}）。`, isError: false };
        }
      }
      if (q.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(norm(q.time))) return { text: '時間請使用 HH:MM 格式。', isError: true };
      const filter = (s: Slot) => (wantedDay === undefined || !!(s.days & (1 << wantedDay))) && (!q.time || s.start >= norm(q.time));
      const matched = shard.stops.filter(s => [s.name, s.village, s.route].some(v => norm(v).includes(keyword)));
      const stops = matched.map(s => ({ ...s, garbage: s.garbage.filter(filter), recycling: s.recycling.filter(filter), food: s.food.filter(filter) })).filter(s => s.garbage.length + s.recycling.length + s.food.length);
      if (q.time) stops.sort((a, b) => [...a.garbage, ...a.recycling, ...a.food].map(s => s.start).sort()[0].localeCompare([...b.garbage, ...b.recycling, ...b.food].map(s => s.start).sort()[0]));
      const prefix = `${cities[city].name}${district}${q.keyword ? `「${q.keyword}」` : ''}：`;
      const lines = [shard.truncated ? `${prefix}符合的收運點超過 200 筆，請加上里名或路段縮小範圍。` : stops.length ? `${prefix}共 ${stops.length} 個收運點` : `${prefix}${matched.length ? '有收運點，但不符合指定的星期或時間。' : '找不到符合的收運點，試試較短的關鍵字或里名。'}`];
      const format = (slots: Slot[]) => slots.map(s => `週${[...dayNames].filter((_, i) => s.days & 1 << i).join('、')} ${s.start}${s.end && s.end !== s.start ? `–${s.end}` : ''}`).join('；');
      for (const s of (shard.truncated ? [] : stops.slice(0, 15))) {
        lines.push(`${s.name}（${s.village}，路線 ${s.route}）`);
        for (const [label, slots] of [['一般垃圾', s.garbage], ['資源回收', s.recycling], ['廚餘', s.food]] as const) if (slots.length) lines.push(`${label}：${format(slots)}`);
        if (s.note) lines.push(`備註：${s.note}`);
      }
      if (!shard.truncated && stops.length > 15) lines.push('僅顯示前 15 筆，請用里名、關鍵字或時間縮小範圍。');
      const local = new Date(Date.parse(info.fetchedAt) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`資料來源：${cities[city].source}，政府資料開放授權條款第1版（OGDL-1）`, `資料時間：${local}（台北時間）${now.getTime() - Date.parse(info.fetchedAt) > 3 * 86400000 ? '；資料可能已過時' : ''}`);
      if (city === 'taipei') lines.push('臺北市收運日依環保局週收五日規則推定，週三、週日停收；部分回收日依站點名稱標示，部分站點僅資源回收車收運；廚餘依環保局規則隨垃圾車收運。');
      if (city === 'kaohsiung') { const d = new Date(Date.parse(info.fetchedAt) + 8 * 3600000); lines.push(`高雄市資料只含 ${d.getUTCMonth() + 1}/${d.getUTCDate()}（星期${dayNames[info.capturedWeekday ?? d.getUTCDay()]}）當日班表${d.toISOString().slice(0, 10) !== new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10) ? '（非今日資料）' : ''}`); }
      lines.push('實際收運以各地環保局公告為準（國定假日可能調整）');
      return { text: lines.join('\n'), isError: false };
    } catch { return { text: '暫時無法取得垃圾車資料，請稍後再試。', isError: true }; }
  } };
}
