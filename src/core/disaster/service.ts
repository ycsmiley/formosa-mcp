import { counties } from '../outage/districts.js';
import { canonical } from '../outage/normalize.js';
import { local, addDays } from '../outage/time.js';
import { official, severities, type Index, type Source, type State, type Dgpa, type Alert } from './model.js';
export interface DisasterStore { indexes(): Promise<{ worker: Index | null; gha: Index | null }>; shard(source: Source, sha: string): Promise<Dgpa | Alert[] | null> }
const reminder = '提醒：停班停課以各縣市政府及人事行政總處公告為準；民間企業依勞動部規定。';
const dgpaSource = `來源：行政院人事行政總處 ${official.dgpa}`;
const ncdrSource = `資料來源：國家災害防救科技中心（NCDR）民生示警公開資料平臺 ${official.ncdr}`;
const time = (s?: string, seconds = false) => s ? new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, seconds ? 19 : 16).replace('T', ' ') : '未知';
const safeReason = (s?: string) => !s || s.includes('照常') ? '尚無成功取得的資料' : s;
export function resolveCities(input: string): string[] {
  const name = canonical(input.replace(/\s+/g, ''));
  if (name === '新竹' || name === '嘉義') return [name + '市', name + '縣'];
  return counties.filter(c => name.startsWith(c) || c === name + '市' || c === name + '縣');
}
export function createDisasterService(store: DisasterStore, clock = () => new Date()) {
  async function load(source: Source) {
    let indexes: Awaited<ReturnType<DisasterStore['indexes']>> = { worker: null, gha: null };
    try { indexes = await store.indexes(); } catch { /* Report unavailable below. */ }
    const states = [indexes.worker?.sources[source], indexes.gha?.sources[source]].filter((s): s is State => !!s);
    const chosen = states.filter(s => s.lastSuccessAt && s.sha).sort((a, b) => Date.parse(b.lastSuccessAt!) - Date.parse(a.lastSuccessAt!))[0];
    const attempt = states.filter(s => s.fetchedAt && !s.skipped).sort((a, b) => Date.parse(b.fetchedAt!) - Date.parse(a.fetchedAt!))[0];
    const stale = !!chosen && (clock().getTime() - Date.parse(chosen.lastSuccessAt!) > 90 * 60000 || source === 'dgpa' && (!chosen.sourceUpdatedAt || clock().getTime() - Date.parse(chosen.sourceUpdatedAt) > 90 * 60000));
    let data: Dgpa | Alert[] | null = null, reason = attempt?.reason || '尚無成功取得的資料';
    if (chosen && !attempt?.closed) {
      try { data = await store.shard(source, chosen.sha!); if (!data || (Array.isArray(data) ? data.length : Object.keys(data.counties).length) !== chosen.count) { data = null; reason = '資料快照遺失或無法解讀'; } }
      catch { reason = '資料快照遺失或無法解讀'; }
    }
    return { chosen, attempt, stale, data, reason: safeReason(reason) };
  }
  function cities(city: string) {
    const cs = city.length >= 1 && city.length <= 30 ? resolveCities(city) : [];
    return { cs, prefix: cs.length === 2 ? [`「${cs[0].slice(0, -1)}」可能指${cs[0]}或${cs[1]}，以下兩者都列出。`] : [] };
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
        if (snapshot.noEvent) { lines.push('官方頁面：「無停班停課訊息。」'); continue; }
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
      return { text: [...lines, dgpaSource, reminder].join('\n'), isError: false };
    },
    async alerts(q: { city: string }) {
      const { cs, prefix } = cities(q.city); if (!cs.length) return invalid(ncdrSource);
      const { chosen, attempt, stale, data, reason } = await load('ncdr');
      const lines = [...(stale && !attempt?.closed && data ? [`⚠️ 資料可能過期，請以官方公告為準：${official.ncdr}`] : []), ...prefix];
      if (attempt?.closed) lines.push(`disaster_alerts 尚未支援：NCDR 匿名告警來源已要求登入會員（${safeReason(attempt.reason)}），本服務不使用金鑰。請至 ${official.ncdr} 查詢。`);
      else if (!Array.isArray(data)) lines.push(`目前無法取得 NCDR 災防告警（${reason}），請至 ${official.ncdr} 查詢。`);
      else {
        if (attempt && !attempt.ok && !stale) lines.push(`最近一次抓取失敗，以下為 ${time(chosen?.lastSuccessAt).slice(11)} 的資料。`);
        for (const county of cs) {
          const items = data.filter(e => e.counties.includes(county) && (!e.expires || Date.parse(e.expires) > clock().getTime()) && (!e.effective || Date.parse(e.effective) <= clock().getTime())).sort((a, b) => severities.indexOf(a.severity ?? 'Unknown') - severities.indexOf(b.severity ?? 'Unknown') || (Date.parse(b.effective ?? '') || 0) - (Date.parse(a.effective ?? '') || 0));
          if (!items.length) lines.push(`目前沒有${county}生效中的告警（國家災害防救科技中心，資料時間 ${time(chosen?.sourceUpdatedAt)}）`);
          else {
            lines.push(`${county} 生效中的災防告警`);
            for (const item of items.slice(0, 20)) {
              const severity = item.severity ? ({ Extreme: '極嚴重', Severe: '嚴重', Moderate: '中度', Minor: '輕微', Unknown: '未知' }[item.severity]) : '未提供';
              lines.push(`【${item.type}】${item.title || item.type}${item.type === '地震' ? '（地震資訊以中央氣象署為準）' : item.type === '停水' ? '（停水詳情可用 outage_schedule 查詢）' : ''}`, `等級：${severity}${item.level ? `（${item.level}）` : ''}`, `生效：${item.effective || '未提供'}　到期：${item.expires || '未提供'}`, `發布單位：${item.sender || '未提供'}`, `內容：${item.text}`, `連結：${item.link}`);
              if (!item.detail) lines.push('（尚未取得 CAP 詳細資料，等級與範圍依摘要判定）');
            }
            if (items.length > 20) lines.push(`另有 ${items.length - 20} 則`);
          }
        }
      }
      lines.push(`來源更新時間：${time(chosen?.sourceUpdatedAt, true)}（臺北時間）`, `本服務抓取時間：${time(chosen?.lastSuccessAt)}（臺北時間）`, ncdrSource);
      return { text: lines.join('\n'), isError: false };
    },
  };
}
