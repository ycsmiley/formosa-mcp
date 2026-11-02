import { decodeIndex, decodeAlerts, indexKey, shardKey, official, feedUrls, sources, type Index, type State, type Writer, type Alert } from './model.js';
import { parseDgpa, parseNcdrJson, parseNcdrAtom, parseCap, LoginRequired, type Feed } from './parse.js';
export interface Store { get(key: string): Promise<string | null>; put(key: string, value: string, ttlSeconds?: number): Promise<void> }
export interface Options { writer: Writer; store: Store; fetchText: (url: string) => Promise<{ status: number; text: string }>; now?: () => Date; sleep: (ms: number) => Promise<void>; peerIndex?: () => Promise<Index | null>; maxCaps: number; ncdrDeadlineMs?: number; quietWindow?: boolean; token?: string }
export const reason = (e: unknown, token?: string) => (token ? String(e instanceof Error ? e.message : e).replaceAll(token, '[redacted]') : String(e instanceof Error ? e.message : e)).replace(/https?:\/\/[^\s]+/gi, '[url]').replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]').replace(/(?:token|key|secret)=\S+/gi, '[redacted]').replace(/\s+/g, ' ').slice(0, 200);
// Worker starts at x5, starts NCDR requests within 60s; hourly Actions starts at :20.
// Delayed Actions avoid x4:30–x7:00; this is staggering, not a distributed lock.
export function quietDelayMs(date: Date): number {
  const ms = (date.getUTCMinutes() % 10) * 60000 + date.getUTCSeconds() * 1000 + date.getUTCMilliseconds();
  return ms >= 4.5 * 60000 && ms < 7 * 60000 ? 7 * 60000 - ms : 0;
}
const responseTimes = new WeakMap<Store, number>();
const changed = (a?: State, b?: State) => ['ok', 'closed', 'sha', 'reason'].some(k => a?.[k as keyof State] !== b?.[k as keyof State]);
export async function collectDisaster(o: Options): Promise<{ index: Index; previous: Index; writes: number; exitCode: number }> {
  const now = o.now ?? (() => new Date()), started = now().getTime();
  const raw = await o.store.get(indexKey(o.writer));
  const previous: Index = raw ? decodeIndex(raw) : { v: 1, writer: o.writer, heartbeatAt: new Date(started).toISOString(), sources: {} };
  if (previous.writer !== o.writer) throw Error('災防索引寫入者不符');
  let peer: Index | null = null;
  if (o.peerIndex) { try { peer = await o.peerIndex(); } catch { /* Independent fallback still fetches when peer is unavailable. */ } }
  const heartbeatDue = !raw || started - Date.parse(previous.heartbeatAt) >= 19 * 60000;
  const index: Index = { v: 1, writer: o.writer, heartbeatAt: previous.heartbeatAt, sources: {} };
  let writes = 0, exitCode = 0, finished = responseTimes.get(o.store);
  async function request(url: string): Promise<string> {
    // Every NCDR request starts >=3.1s after the preceding response (including errors).
    if (finished !== undefined) { const delay = finished + 3100 - now().getTime(); if (delay > 0) await o.sleep(delay); }
    if (o.quietWindow) { const delay = quietDelayMs(now()); if (delay) await o.sleep(delay); }
    if (o.ncdrDeadlineMs !== undefined && now().getTime() - started > o.ncdrDeadlineMs) throw Error('NCDR 本輪請求時間已用完');
    try {
      const response = await o.fetchText(url);
      if (response.text.includes('請先登入會員')) throw new LoginRequired();
      if (response.status !== 200) throw Error(`NCDR HTTP ${response.status}`);
      return response.text;
    } finally { finished = now().getTime(); responseTimes.set(o.store, finished); }
  }
  async function ncdr(old?: State): Promise<{ data: Alert[]; updated: string }> {
    let feed: Feed | undefined, login = 0, failure: unknown;
    for (const [i, url] of feedUrls.entries()) {
      try { const body = await request(url); feed = (i === 0 ? parseNcdrJson : parseNcdrAtom)(body, now()); break; }
      catch (e) { if (e instanceof LoginRequired) login++; failure = e; }
    }
    if (!feed) { if (login === 2) throw new LoginRequired(); throw Error(failure instanceof LoginRequired ? 'NCDR 備援來源無法取得' : reason(failure, o.token)); }
    const detailed = new Map<string, Alert>();
    for (const state of [old, peer?.sources.ncdr]) {
      if (!state?.sha) continue;
      try { const raw = await o.store.get(shardKey('ncdr', state.sha)); if (raw) for (const item of decodeAlerts(raw)) if (item.detail) detailed.set(item.id, item); } catch { /* Retry CAP if the prior shard is unavailable. */ }
    }
    let caps = 0; const data: Alert[] = [];
    for (const e of feed.entries) {
      const { status: _status, msgType: _msgType, ...base } = e;
      const retained = detailed.get(e.id); if (retained) { data.push(retained); continue; }
      let item: Alert = base;
      let safe = false;
      try { const url = new URL(e.link); safe = url.protocol === 'https:' && url.hostname === 'alerts.ncdr.nat.gov.tw' && !url.port && !url.username && !url.password; } catch { /* Summary remains usable. */ }
      if (safe && caps < o.maxCaps && (o.ncdrDeadlineMs === undefined || now().getTime() - started <= o.ncdrDeadlineMs)) {
        caps++;
        try {
          const body = await request(e.link);
          if (new TextEncoder().encode(body).length > 256 * 1024) throw Error('CAP 超過大小上限');
          const cap = parseCap(body);
          if (cap.id !== e.id) throw Error('CAP 識別碼不符');
          if (cap.status !== 'Actual' || cap.msgType === 'Cancel') continue;
          const { status: _s, msgType: _m, onset: _o, web: _w, ...detail } = cap;
          item = { ...detail, ...(detail.effective || base.effective ? { effective: detail.effective ?? base.effective } : {}), ...(detail.expires || base.expires ? { expires: detail.expires ?? base.expires } : {}), link: e.link, detail: true };
        } catch { /* CAP failures retain summary; retry entries lacking detail next run. */ }
      }
      data.push(item);
    }
    return { data, updated: feed.updated };
  }
  for (const source of sources) {
    const old = previous.sources[source], peerState = peer?.sources[source];
    if (o.writer === 'gha' && peer?.writer === 'worker' && peerState?.lastSuccessAt && now().getTime() - Date.parse(peerState.lastSuccessAt) <= 25 * 60000 && now().getTime() >= Date.parse(peerState.lastSuccessAt)) {
      index.sources[source] = { ...(old ?? { ok: false }), skipped: true }; continue;
    }
    let publicationFailed = false;
    try {
      let data: unknown, updated: string, count: number;
      if (source === 'dgpa') {
        const response = await o.fetchText(official.dgpa);
        if (response.status !== 200) throw Error(`人事行政總處 HTTP ${response.status}`);
        const { updatedAt, ...snapshot } = parseDgpa(response.text); data = snapshot; updated = updatedAt; count = Object.keys(snapshot.counties).length;
      } else { const result = await ncdr(old); data = result.data; updated = result.updated; count = result.data.length; }
      const encoded = JSON.stringify(data), digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded)), sha = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 12);
      const fetchedAt = now().toISOString(); let writtenAt = old?.writtenAt;
      // Renew on a heartbeat run so the renewed writtenAt is durably indexed too.
      if (old?.sha !== sha || !writtenAt || (o.writer === 'gha' || heartbeatDue || old.ok !== true) && now().getTime() - Date.parse(writtenAt) > 3 * 86400000) {
        try { await o.store.put(shardKey(source, sha), encoded, 8 * 86400); writes++; writtenAt = fetchedAt; }
        catch (e) { publicationFailed = true; throw e; }
      }
      index.sources[source] = { ok: true, fetchedAt, lastSuccessAt: fetchedAt, sourceUpdatedAt: updated, sha, count, writtenAt };
    } catch (e) {
      const closed = e instanceof LoginRequired;
      index.sources[source] = { ...old, ok: false, skipped: false, closed, reason: reason(e, o.token), fetchedAt: now().toISOString() };
      // A repeated login wall is a warning after its first report, independent of old data age.
      if (publicationFailed || (closed ? !old?.closed : old?.ok || !old?.lastSuccessAt || now().getTime() - Date.parse(old.lastSuccessAt) > 86400000)) exitCode = 1;
    }
  }
  if (o.writer === 'gha' || heartbeatDue || sources.some(s => changed(previous.sources[s], index.sources[s]))) {
    // Anchor heartbeat to run start: slow responses must not turn a 20m cadence into 30m.
    index.heartbeatAt = new Date(started).toISOString();
    // Shards first, writer's index last; failures never replace last good references.
    try { await o.store.put(indexKey(o.writer), JSON.stringify(index)); writes++; } catch { exitCode = 1; }
  }
  return { index, previous, writes, exitCode };
}
