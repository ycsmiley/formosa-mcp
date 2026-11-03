import { counties, districts } from '../outage/districts.js';
import { canonical } from '../outage/normalize.js';
import { local, addDays } from '../outage/time.js';
import { official, safeLink, severities, type Index, type Source, type Writer, type State, type Dgpa, type Alert } from './model.js';
export interface DisasterStore { indexes(source?: Source): Promise<{ worker: Index | null; gha: Index | null; errors?: Partial<Record<Writer, boolean>> }>; shard(source: Source, sha: string): Promise<Dgpa | Alert[] | null> }
const reminder = '提醒：停班停課以各縣市政府及人事行政總處公告為準；民間企業依勞動部規定。';
const dgpaSource = `來源：行政院人事行政總處 ${official.dgpa}`;
const ncdrSource = `資料來源：國家災害防救科技中心（NCDR）民生示警公開資料平臺 ${official.ncdr}`;
const time = (s?: string, seconds = false) => s ? new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, seconds ? 19 : 16).replace('T', ' ') : '未知';
const safeReason = (s?: string) => !s || s.includes('照常') ? '尚無成功取得的資料' : s;
// Encode each line once; retain attribution at the end within the UTF-8 byte budget.
function response(lines: string[], tail: string[], link: string) {
  const encoder = new TextEncoder(), size = (s: string) => encoder.encode(s).length;
  const full = [...lines, ...tail].join('\n');
  if (size(full) <= 16 * 1024) return full;
  const ending = [`（內容過長已截斷，完整資訊請見 ${link}）`, ...tail].join('\n');
  let used = size(ending), kept: string[] = [];
  for (const line of lines) { const bytes = size(line) + 1; if (used + bytes > 16 * 1024) break; kept.push(line); used += bytes; }
  return [...kept, ending].join('\n');
}
export function resolveCities(input: string): string[] {
  const name = canonical(input.replace(/\s+/g, ''));
  if (name === '馬祖') return ['連江縣'];
  if (name === '新竹' || name === '嘉義') return [name + '市', name + '縣'];
  const direct = counties.filter(c => name.startsWith(c) || c === name + '市' || c === name + '縣');
  if (direct.length) return direct;
  const owners = counties.filter(c => districts[c].some(d => canonical(d) === name));
  return owners.length === 1 ? owners : [];
}
export function createDisasterService(store: DisasterStore, clock = () => new Date()) {
  async function load(source: Source) {
    let indexes: Awaited<ReturnType<DisasterStore['indexes']>> = { worker: null, gha: null };
    try { indexes = await store.indexes(source); } catch { indexes.errors = { worker: true, gha: true }; }
    const states = [indexes.worker?.sources[source], indexes.gha?.sources[source]].filter((s): s is State => !!s);
    const instant = clock().getTime();
    const healthy = states.filter(s => ![s.lastSuccessAt, s.sourceUpdatedAt].some(t => t && Date.parse(t) - instant > 5 * 60000));
    const chosen = healthy.filter(s => s.lastSuccessAt && s.sha).sort((a, b) => (Date.parse(b.sourceUpdatedAt ?? '') || 0) - (Date.parse(a.sourceUpdatedAt ?? '') || 0) || Date.parse(b.lastSuccessAt!) - Date.parse(a.lastSuccessAt!))[0];
    const attempt = healthy.filter(s => s.fetchedAt && !s.skipped).sort((a, b) => Date.parse(b.fetchedAt!) - Date.parse(a.fetchedAt!) || Number(a.ok) - Number(b.ok))[0];
    const anomalous = !chosen && states.some(s => s.lastSuccessAt && s.sha && !healthy.includes(s));
    const partial = Object.values(indexes.errors ?? {}).some(Boolean);
    const unreadable = !states.length && partial;
    const expiredSource = !!chosen && (!chosen.sourceUpdatedAt || instant - Date.parse(chosen.sourceUpdatedAt) > (source === 'ncdr' ? 24 * 3600000 : 90 * 60000));
    const stale = !!chosen && (expiredSource || instant - Date.parse(chosen.lastSuccessAt!) >= 90 * 60000);
    let data: Dgpa | Alert[] | null = null, reason = unreadable ? '索引無法解讀' : anomalous ? '資料時間異常' : source === 'ncdr' && expiredSource ? '來源更新時間已超過 24 小時或缺失' : attempt?.reason || '尚無成功取得的資料';
    if (chosen && !attempt?.closed && !(source === 'ncdr' && expiredSource)) {
      try { data = await store.shard(source, chosen.sha!); if (!data || (Array.isArray(data) ? data.length : Object.keys(data.counties).length) !== chosen.count) { data = null; reason = '資料快照遺失或無法解讀'; } }
      catch { reason = '資料快照遺失或無法解讀'; }
    }
    return { chosen, attempt, stale, anomalous, partial, data, reason: safeReason(reason) };
  }
  function cities(city: string) {
    const cs = city.length >= 1 && city.length <= 30 ? resolveCities(city) : [];
    return { cs, prefix: cs.length === 2 ? [`「${cs[0].slice(0, -1)}」可能指${cs[0]}或${cs[1]}，以下兩者都列出。`] : cs.length === 1 && (canonical(city.replace(/\s+/g, '')) === '馬祖' || districts[cs[0]].some(d => canonical(d) === canonical(city.replace(/\s+/g, '')))) ? [`「${city}」屬${cs[0]}，以下顯示${cs[0]}。`] : [] };
  }
  const invalid = (source: string) => ({ text: `請提供有效臺灣縣市名稱：${counties.join('、')}。\n${source}`, isError: true });
  return {
    async closure(q: { city: string }) {
      const { cs, prefix } = cities(q.city); if (!cs.length) return invalid(dgpaSource + '\n' + reminder);
      const { chosen, attempt, stale, data, reason } = await load('dgpa'), snapshot = data && !Array.isArray(data) ? data : null;
      const lines = [...(stale && snapshot ? [`⚠️ 資料可能過期，請以官方公告為準：${official.dgpa}`] : []), ...prefix];
      for (const county of cs) {
        lines.push(`${county} 天然災害停止上班及上課情形`);
        lines.push(`官方頁面更新時間：${time(chosen?.sourceUpdatedAt, true)}（臺北時間）`, `本服務抓取時間：${time(chosen?.lastSuccessAt)}（臺北時間）`);
        if (!snapshot) { lines.push(`目前無法取得人事行政總處停班停課資料（${reason}），請至 ${official.dgpa} 查詢。`); continue; }
        if (attempt && !attempt.ok && !stale) lines.push(`最近一次抓取失敗，以下為 ${time(chosen?.lastSuccessAt).slice(11)} 的資料。`);
        const today = local(clock()).slice(0, 10), tomorrow = addDays(today, 1);
        if (snapshot.pageDate !== today) lines.push(`注意：官方頁面日期為 ${snapshot.pageDate}，與今天不同。`);
        if (snapshot.noEvent) { lines.push(stale ? '資料已過期，官方頁面當時顯示「無停班停課訊息。」，目前狀態請查官方頁面。' : '官方頁面：「無停班停課訊息。」'); continue; }
        const original = snapshot.counties[county]; if (!original) { lines.push('官方頁面未列本縣市'); continue; }
        const groups = new Map<string, string[]>();
        for (const line of original) {
          const day = /^(今天|明天)/.exec(line)?.[1] || /^[^:：]+[:：]\s*(今天|明天)/.exec(line)?.[1];
          const key = day ? addDays(snapshot.pageDate, day === '今天' ? 0 : 1) : '未標明日期';
          groups.set(key, [...groups.get(key) ?? [], line]);
        }
        const days = [...new Set([today, tomorrow, ...[...groups.keys()].filter(k => k !== '未標明日期')])].sort();
        for (const day of [...days, ...(groups.has('未標明日期') ? ['未標明日期'] : [])]) {
          const label = day === '未標明日期' ? day : `${day.slice(5).replace('-', '/')}（${day === today ? '今天' : day === tomorrow ? '明天' : day}）`;
          lines.push(`${label}：`);
          const entries = groups.get(day);
          if (!entries) lines.push('官方頁面未列本縣市該日訊息');
          else for (const entry of entries) lines.push(stale && entry.includes('照常') ? '（此行原文含「照常」，因資料可能過期不予顯示，請查官方頁面）' : `「${entry}」`);
        }
      }
      return { text: response(lines, [dgpaSource, reminder], official.dgpa), isError: false };
    },
    async alerts(q: { city: string }) {
      const { cs, prefix } = cities(q.city); if (!cs.length) return invalid(ncdrSource);
      const { chosen, attempt, stale, partial, data, reason } = await load('ncdr');
      const lines = [...(stale && !attempt?.closed && data ? [`⚠️ 資料可能過期，請以官方公告為準：${official.ncdr}`] : []), ...prefix];
      if (attempt?.closed) lines.push(`disaster_alerts 尚未支援：NCDR 匿名告警來源已要求登入會員（${safeReason(attempt.reason)}），本服務不使用金鑰。請至 ${official.ncdr} 查詢。`);
      else if (!Array.isArray(data)) lines.push(`目前無法取得 NCDR 災防告警（${reason}），請至 ${official.ncdr} 查詢。`);
      else {
        const instant = clock().getTime();
        const live = data.filter(e => !e.expires || Date.parse(e.expires) > instant);
        const incomplete = live.some(e => e.complete !== true);
        const verified = data.length > 0 || chosen?.empty === true;
        const reliable = !partial && !stale && attempt?.ok === true && verified && !incomplete;
        const sort = (a: Alert, b: Alert) => severities.indexOf(a.severity ?? 'Unknown') - severities.indexOf(b.severity ?? 'Unknown') || (Date.parse(b.effective ?? '') || 0) - (Date.parse(a.effective ?? '') || 0);
        function list(items: Alert[], county: string, upcoming = false) {
          for (const item of items.slice(0, 20)) {
            const severity = item.severity ? ({ Extreme: '極嚴重', Severe: '嚴重', Moderate: '中度', Minor: '輕微', Unknown: '未知' }[item.severity]) : '未提供';
            lines.push(`【${item.type}】${item.title || item.type}${item.type === '地震' ? '（地震資訊以中央氣象署為準）' : item.type === '停水' ? '（停水詳情可用 outage_schedule 查詢）' : ''}${item.complete !== true ? '（範圍未完全確認）' : ''}`);
            if (upcoming) lines.push(`即將生效：${time(item.effective)}（臺北時間）`);
            lines.push(`等級：${severity}${item.level ? `（${item.level}）` : ''}`, `生效：${item.effective || '未提供'}　到期：${item.expires || '未提供'}`, `發布單位：${item.sender || '未提供'}`, `內容：${item.text}`, `連結：${safeLink(item.link)}`);
            const areas = item.detail ? item.areas?.filter((a, i) => canonical(a).startsWith(county) || item.areaCounties?.[i]?.includes(county)) ?? [] : [];
            if (areas.length) lines.push(`範圍：${areas.slice(0, 15).join('、')}${areas.length > 15 ? `等 ${areas.length} 處` : ''}`);
            if (!item.detail) lines.push('（尚未取得 CAP 詳細資料，等級與範圍依摘要判定）');
          }
          if (items.length > 20) lines.push(`另有 ${items.length - 20} 則`);
        }
        for (const county of cs) {
          const matches = live.filter(e => e.counties.includes(county));
          const items = matches.filter(e => !e.effective || Date.parse(e.effective) <= instant).sort(sort);
          const upcoming = matches.filter(e => e.effective && Date.parse(e.effective) > instant).sort(sort);
          const unknown = live.filter(e => e.complete !== true && !e.counties.includes(county));
          if (partial) lines.push(`部分寫入端索引讀取失敗，無法確認${county}目前是否有告警，請至 ${official.ncdr} 查詢。`);
          if (!attempt) lines.push(`缺少最近一次抓取狀態，無法確認${county}目前是否有告警，請至 ${official.ncdr} 查詢。`);
          if (attempt && !attempt.ok) lines.push(`最近一次抓取失敗（${safeReason(attempt.reason)}），無法確認${county}目前是否有告警，請至 ${official.ncdr} 查詢。`);
          if (stale) lines.push(`資料已過期（${time(chosen?.sourceUpdatedAt)}），無法確認${county}目前是否有告警，請至 ${official.ncdr} 查詢。`);
          if (!verified) lines.push(`目前無法取得可確認的 NCDR 空清單，無法確認${county}目前是否有告警，請至 ${official.ncdr} 查詢。`);
          if (incomplete) lines.push(`告警範圍資料不完整，無法確認${county}目前是否有其他告警，請至 ${official.ncdr} 查詢。`);
          if (!items.length && reliable) lines.push(upcoming.length ? `目前沒有${county}生效中的告警，但有 ${upcoming.length} 則即將生效：` : `目前沒有${county}生效中的告警（國家災害防救科技中心，資料時間 ${time(chosen?.sourceUpdatedAt)}）`);
          if (items.length) { lines.push(`${county} 生效中的災防告警`); list(items, county); }
          if (upcoming.length) { lines.push(`${county} 即將生效的告警`); list(upcoming, county, true); }
          if (unknown.length) {
            lines.push(`${county}：有 ${unknown.length} 則告警無法確認是否涵蓋本縣市：`);
            for (const item of unknown.slice(0, 5)) lines.push(`【${item.type}】${item.title || item.type}`, `連結：${safeLink(item.link)}`);
            if (unknown.length > 5) lines.push(`另有 ${unknown.length - 5} 則`);
          }
        }
      }
      const tail = [`來源更新時間：${time(chosen?.sourceUpdatedAt, true)}（臺北時間）`, `本服務抓取時間：${time(chosen?.lastSuccessAt)}（臺北時間）`, ncdrSource];
      return { text: response(lines, tail, official.ncdr), isError: false };
    },
  };
}
