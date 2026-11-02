import { decodeIndex, decodeAlerts, indexKey, shardKey, official, safeLink, feedUrls, sources, type Index, type State, type Writer, type Alert, type Source } from './model.js';
import { parseDgpa, parseNcdrJson, parseNcdrAtom, parseCap, LoginRequired, type Feed } from './parse.js';
export interface Store { get(key: string): Promise<string | null>; put(key: string, value: string, ttlSeconds?: number): Promise<void> }
export interface Options { writer: Writer; store: Store; fetchText: (url: string) => Promise<{ status: number; text: string }>; now?: () => Date; sleep: (ms: number) => Promise<void>; peerIndex?: () => Promise<Index | null>; maxCaps: number; ncdrDeadlineMs?: number; scheduledAt?: number; quietWindow?: boolean; token?: string; only?: Source[]; budget?: { perHour: number; burst: number }; warn?: (message: string) => void }
export const reason = (e: unknown, token?: string) => (token ? String(e instanceof Error ? e.message : e).replaceAll(token, '[redacted]') : String(e instanceof Error ? e.message : e)).replace(/https?:\/\/[^\s]+/gi, '[url]').replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]').replace(/(?:token|key|secret)=\S+/gi, '[redacted]').replace(/\s+/g, ' ').slice(0, 200);
// Worker starts at x5, starts NCDR requests within 60s; hourly Actions starts at :20.
// Delayed Actions avoid x4:30–x7:00; this is staggering, not a distributed lock.
export function quietDelayMs(date: Date): number {
  const ms = (date.getUTCMinutes() % 10) * 60000 + date.getUTCSeconds() * 1000 + date.getUTCMilliseconds();
  return ms >= 4.5 * 60000 && ms < 7 * 60000 ? 7 * 60000 - ms : 0;
}
const responseTimes = new WeakMap<Store, number>();
const changed = (a?: State, b?: State) => ['ok', 'closed', 'sha', 'reason', 'empty', 'skipped'].some(k => a?.[k as keyof State] !== b?.[k as keyof State]);
export async function collectDisaster(o: Options): Promise<{ index: Index; previous: Index; writes: number; exitCode: number }> {
  const now = o.now ?? (() => new Date()), started = now().getTime(), scheduled = o.scheduledAt ?? started;
  const guardEnd = Math.floor(scheduled / 600000) * 600000 + 7 * 60000;
  const raw = await o.store.get(indexKey(o.writer));
  let stored: Index | null = null;
  if (raw !== null) {
    try { stored = decodeIndex(raw); }
    catch { o.warn?.(`disaster ${o.writer} 索引無法解讀，重新建立`); }
  }
  const previous: Index = stored ?? { v: 1, writer: o.writer, heartbeatAt: new Date(started).toISOString(), sources: {} };
  if (previous.writer !== o.writer) throw Error('災防索引寫入者不符');
  let peer: Index | null = null;
  if (o.peerIndex) { try { peer = await o.peerIndex(); } catch { /* Independent fallback still fetches when peer is unavailable. */ } }
  // A 55m heartbeat becomes ~60–70m on cron cadence, within the 90m freshness window.
  const heartbeatDue = !stored || started - Date.parse(previous.heartbeatAt) >= 55 * 60000;
  const index: Index = { v: 1, writer: o.writer, heartbeatAt: previous.heartbeatAt, sources: { ...previous.sources }, ...(previous.budget ? { budget: previous.budget } : {}) };
  const shards = new Map<Source, { encoded: string; sha: string }>();
  let writes = 0, exitCode = 0, finished = responseTimes.get(o.store);
  async function request(url: string): Promise<string> {
    // Every NCDR request starts >=3.1s after the preceding response (including errors).
    if (finished !== undefined) { const delay = finished + 3100 - now().getTime(); if (delay > 0) await o.sleep(delay); }
    if (o.quietWindow) { const delay = quietDelayMs(now()); if (delay) await o.sleep(delay); }
    if ((o.ncdrDeadlineMs !== undefined && now().getTime() - scheduled >= o.ncdrDeadlineMs) || (o.scheduledAt !== undefined && now().getTime() >= guardEnd)) throw Error('NCDR 本輪請求時間已用完');
    try {
      const response = await o.fetchText(url);
      if (response.text.includes('請先登入會員')) throw new LoginRequired();
      if (response.status !== 200) throw Error(`NCDR HTTP ${response.status}`);
      return response.text;
    } finally { finished = now().getTime(); responseTimes.set(o.store, finished); }
  }
  async function ncdr(old?: State): Promise<{ data: Alert[]; updated: string }> {
    // Legacy CAP shards must be refreshed once to recover geocode-only coverage.
    const detailed = new Map<string, Alert>();
    for (const state of [old, peer?.sources.ncdr]) {
      if (!state?.sha) continue;
      try { const raw = await o.store.get(shardKey('ncdr', state.sha)); if (raw) for (const item of decodeAlerts(raw)) if (item.detail && item.complete !== undefined && item.areaCounties !== undefined) detailed.set(item.id, item); } catch { /* Retry CAP if the prior shard is unavailable. */ }
    }
    const retainedIds = new Set(detailed.keys());
    const emptyError = () => Error('NCDR 回傳 0 筆告警，無法確認為有效空清單');
    let feed: Feed | undefined, primary: Feed | undefined, login = 0, failure: unknown;
    for (const [i, url] of feedUrls.entries()) {
      try {
        const parsed = (i === 0 ? parseNcdrJson : parseNcdrAtom)(await request(url), now(), retainedIds);
        if (i === 0) {
          primary = parsed;
          if (parsed.entries.length) { feed = parsed; break; }
        } else {
          // NCDR has no explicit empty signal. Require structurally valid, fresh JSON
          // AND Atom with zero usable entries. Disagreement fails closed (no replacement).
          if (primary && !parsed.entries.length && !primary.entries.length) {
            // Anchor verification to the older evidence so neither format outlives its freshness.
            feed = { ...parsed, updated: Date.parse(primary.updated) < Date.parse(parsed.updated) ? primary.updated : parsed.updated };
          }
          else if (!primary && parsed.entries.length) feed = parsed;
          else throw emptyError();
        }
      } catch (e) { if (e instanceof LoginRequired) login++; failure = e; }
    }
    if (!feed) { if (login === 2) throw new LoginRequired(); if (primary && !primary.entries.length) throw emptyError(); throw Error(failure instanceof LoginRequired ? 'NCDR 備援來源無法取得' : reason(failure, o.token)); }
    // Update feed slots in place so rotating the fetch order preserves output order.
    const data: (Alert | null)[] = feed.entries.map(e => {
      const { status: _status, msgType: _msgType, ...base } = e;
      return detailed.get(e.id) ?? base;
    });
    const pending = feed.entries.flatMap((e, i) => {
      if (detailed.has(e.id)) return [];
      return e.link !== official.ncdr && safeLink(e.link) === e.link ? [i] : [];
    });
    // Stateless ten-minute rotation prevents failing CAPs from monopolizing the budget.
    const offset = pending.length ? (Math.floor(started / 600000) * o.maxCaps) % pending.length : 0;
    for (let n = 0; n < Math.min(o.maxCaps, pending.length); n++) {
      const i = pending[(offset + n) % pending.length], e = feed.entries[i], base = data[i]!;
      if (o.ncdrDeadlineMs === undefined || now().getTime() - scheduled < o.ncdrDeadlineMs) {
        try {
          const body = await request(e.link);
          if (new TextEncoder().encode(body).length > 256 * 1024) throw Error('CAP 超過大小上限');
          const cap = parseCap(body);
          if (cap.id !== e.id) throw Error('CAP 識別碼不符');
          if (cap.status !== 'Actual' || cap.msgType === 'Cancel') { data[i] = null; continue; }
          const { status: _s, msgType: _m, onset: _o, web: _w, ...detail } = cap;
          data[i] = { ...detail, ...(detail.effective || base.effective ? { effective: detail.effective ?? base.effective } : {}), ...(detail.expires || base.expires ? { expires: detail.expires ?? base.expires } : {}), link: e.link, detail: true };
        } catch (e) { if (e instanceof LoginRequired) throw e; /* Other CAP failures retain incomplete summary. */ }
      }
    }
    const usable = data.filter((e): e is Alert => e !== null);
    if (!usable.length && feed.entries.length) throw emptyError();
    return { data: usable, updated: feed.updated };
  }
  for (const source of sources) {
    if (o.only && !o.only.includes(source)) continue;
    const old = previous.sources[source], peerState = peer?.sources[source];
    const current = now().getTime();
    if (o.writer === 'gha' && peer?.writer === 'worker' && peerState?.ok === true && !peerState.skipped && !peerState.closed && peerState.sha && peerState.lastSuccessAt && peerState.sourceUpdatedAt && current - Date.parse(peerState.lastSuccessAt) >= 0 && current - Date.parse(peerState.lastSuccessAt) < 25 * 60000 && (source === 'ncdr' ? current - Date.parse(peerState.sourceUpdatedAt) <= 24 * 3600000 : current - Date.parse(peerState.sourceUpdatedAt) < 90 * 60000) && Date.parse(peerState.sourceUpdatedAt) - current <= 5 * 60000 && await o.store.get(shardKey(source, peerState.sha)) !== null) {
      index.sources[source] = { ...(old ?? { ok: false }), skipped: true }; continue;
    }
    try {
      let data: unknown, updated: string, count: number;
      if (source === 'dgpa') {
        const response = await o.fetchText(official.dgpa);
        if (response.status !== 200) throw Error(`人事行政總處 HTTP ${response.status}`);
        const { updatedAt, ...snapshot } = parseDgpa(response.text); data = snapshot; updated = updatedAt; count = Object.keys(snapshot.counties).length;
      } else { const result = await ncdr(old); data = result.data; updated = result.updated; count = result.data.length; }
      if (old?.sha && old.sourceUpdatedAt && Date.parse(updated) < Date.parse(old.sourceUpdatedAt)) throw Error('來源更新時間倒退');
      if (peerState?.sha && peerState.sourceUpdatedAt && Date.parse(updated) < Date.parse(peerState.sourceUpdatedAt)) {
        index.sources[source] = { ...(old ?? { ok: false }), skipped: true, reason: '對方已有較新來源版本' }; continue;
      }
      const encoded = JSON.stringify(data), digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded)), sha = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 12);
      const fetchedAt = now().toISOString();
      index.sources[source] = { ok: true, fetchedAt, lastSuccessAt: fetchedAt, sourceUpdatedAt: updated, sha, count, writtenAt: old?.writtenAt ?? fetchedAt, ...(source === 'ncdr' && count === 0 ? { empty: true } : {}) };
      shards.set(source, { encoded, sha });
    } catch (e) {
      const closed = e instanceof LoginRequired;
      index.sources[source] = { ...old, ok: false, skipped: false, closed, reason: reason(e, o.token), fetchedAt: now().toISOString() };
      // A repeated login wall is a warning after its first report, independent of old data age.
      if (closed ? !old?.closed : old?.ok || !old?.lastSuccessAt || now().getTime() - Date.parse(old.lastSuccessAt) > 86400000) exitCode = 1;
    }
  }
  const needsIndex = () => sources.some(s => changed(previous.sources[s], index.sources[s])) || heartbeatDue && sources.some(s => index.sources[s] && !index.sources[s]?.skipped && (!o.only || o.only.includes(s)));
  if (needsIndex()) {
    // Renew unchanged shards only when we are already publishing an index.
    for (const [source, shard] of shards) {
      const old = previous.sources[source];
      if (old?.sha === shard.sha && old.writtenAt && now().getTime() - Date.parse(old.writtenAt) <= 3 * 86400000) shards.delete(source);
    }
    const publicationAt = now().toISOString();
    let tokens = Infinity;
    if (o.budget) {
      const saved = previous.budget;
      tokens = Math.min(o.budget.burst, (saved?.tokens ?? o.budget.burst) + o.budget.perHour * Math.max(0, Date.parse(publicationAt) - Date.parse(saved?.at ?? publicationAt)) / 3600000);
      if (tokens < shards.size + 1) {
        (o.warn ?? console.warn)('disaster KV 預算不足，延後發布');
        // DGPA changes take priority; NCDR's state and reference stay exactly as stored.
        if (changed(previous.sources.dgpa, index.sources.dgpa) && tokens >= (shards.has('dgpa') ? 2 : 1)) {
          if (previous.sources.ncdr) index.sources.ncdr = previous.sources.ncdr; else delete index.sources.ncdr;
          shards.delete('ncdr');
        } else return { index: previous, previous, writes, exitCode };
      }
    }
    index.heartbeatAt = new Date(started).toISOString();
    if (o.budget) index.budget = { tokens: tokens - shards.size - 1, at: publicationAt };
    // Shards first, writer's index last; failed shard writes retain last-good references.
    for (const [source, shard] of shards) {
      try {
        await o.store.put(shardKey(source, shard.sha), shard.encoded, 8 * 86400); writes++;
        index.sources[source]!.writtenAt = now().toISOString();
      } catch (e) {
        index.sources[source] = { ...previous.sources[source], ok: false, skipped: false, closed: false, reason: reason(e, o.token), fetchedAt: now().toISOString() };
        exitCode = 1;
      }
    }
    try { await o.store.put(indexKey(o.writer), JSON.stringify(index)); writes++; } catch { exitCode = 1; }
  }
  return { index, previous, writes, exitCode };
}
