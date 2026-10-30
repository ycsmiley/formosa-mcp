import { DurableObject } from 'cloudflare:workers';
import { allowance, calendar, decide, quota, type BudgetReason, type Counts, type Purpose } from '../core/rail/budget.js';
import { object, string, tdxApiUrl, tdxBase, tokenBody, tokenPath } from '../core/rail/client.js';

export interface TdxEnv {
  SNAPSHOTS: KVNamespace;
  TDX_CLIENT_ID?: string;
  TDX_CLIENT_SECRET?: string;
  TDX_MONTHLY_QUOTA?: string;
  TDX_BASE_URL?: string;
}
export type GatewayReason = BudgetReason | 'auth' | 'upstream';
export type Denied = { ok: false; reason: GatewayReason; retryAfterMs?: number };
export type LiveResult = { ok: true; data: object; fetchedAt: string } | Denied;
export interface Usage {
  month: string; monthUsed: number; monthlyQuota: number; liveCeiling: number; pct: number;
  today: string; todayUsed: number; dailyBudget: number; byPurpose: Record<string, number>; last60s: number; updatedAt: string;
}
const livePath = /^\/v3\/Rail\/TRA\/(?:TrainLiveBoard\/TrainNo\/\d{1,10}|StationLiveBoard\/Station\/[A-Za-z0-9_-]{1,50})$/;

/** One instance named "tdx" owns project credentials, tokens and all admissions. */
export class TdxGateway extends DurableObject<TdxEnv> {
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, { data: object; fetchedAt: string; until: number }>();
  private pending = new Map<string, Promise<LiveResult>>();
  private ips = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: TdxEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tdx_days (day TEXT NOT NULL, purpose TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, purpose));
      CREATE TABLE IF NOT EXISTS tdx_calls (at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tdx_token (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tdx_monitor (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL, fingerprint TEXT NOT NULL);`);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  private counts(now: Date): Counts & { byPurpose: Record<string, number> } {
    const sql = this.ctx.storage.sql, { today, month } = calendar(now), ms = now.getTime();
    sql.exec('DELETE FROM tdx_calls WHERE at <= ?', ms - 60_000);
    sql.exec('DELETE FROM tdx_days WHERE day < ?', calendar(new Date(ms - 62 * 86400_000)).today);
    const rows = sql.exec<{ day: string; purpose: string; count: number }>('SELECT day, purpose, count FROM tdx_days WHERE day >= ? AND day <= ?', `${month}-01`, today).toArray();
    const byPurpose: Record<string, number> = { token: 0, live: 0, snapshot: 0 };
    let monthUsed = 0, todayUsed = 0, snapshotToday = 0;
    for (const row of rows) {
      monthUsed += row.count;
      byPurpose[row.purpose] = (byPurpose[row.purpose] ?? 0) + row.count;
      if (row.day === today) {
        todayUsed += row.count;
        if (row.purpose !== 'live') snapshotToday += row.count;
      }
    }
    return { monthUsed, todayUsed, snapshotToday, byPurpose,
      last60s: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tdx_calls').one().n,
      monthlyQuota: quota(this.env.TDX_MONTHLY_QUOTA), hasKey: !!(this.env.TDX_CLIENT_ID?.trim() && this.env.TDX_CLIENT_SECRET?.trim()) };
  }
  private check(n: number, purpose: Purpose, ipKey?: string): { ok: true } | Denied {
    const now = new Date(), counts = this.counts(now);
    for (const [key, timestamps] of this.ips) {
      const recent = timestamps.filter(at => at > now.getTime() - 3600_000);
      if (recent.length) this.ips.set(key, recent); else this.ips.delete(key);
    }
    counts.ipMisses = ipKey === undefined ? 0 : (this.ips.get(ipKey)?.length ?? 0);
    const result = decide(n, purpose, counts, now);
    if (!result.ok && result.reason === 'minute') {
      const first = this.ctx.storage.sql.exec<{ at: number }>('SELECT at FROM tdx_calls ORDER BY at LIMIT 1').toArray()[0];
      return { ...result, retryAfterMs: Math.min(60_000, Math.max(1, (first?.at ?? now.getTime()) + 60_000 - now.getTime())) };
    }
    return result;
  }
  private record(purpose: 'token' | Purpose) {
    // No await between checking, recording and initiating the upstream call.
    const now = new Date(), sql = this.ctx.storage.sql;
    sql.exec('INSERT INTO tdx_days(day,purpose,count) VALUES(?,?,1) ON CONFLICT(day,purpose) DO UPDATE SET count=count+1', calendar(now).today, purpose);
    sql.exec('INSERT INTO tdx_calls(at) VALUES(?)', now.getTime());
  }
  private cachedToken() {
    return this.ctx.storage.sql.exec<{ token: string; until: number }>('SELECT token, until FROM tdx_token WHERE id=1 AND until > ?', Date.now()).toArray()[0];
  }
  private async admit(purpose: Purpose, ipKey?: string): Promise<{ ok: true; token: string } | Denied> {
    let token = this.cachedToken()?.token;
    const decision = this.check(token ? 1 : 2, purpose, ipKey);
    if (!decision.ok) return decision;
    if (purpose === 'live' && ipKey !== undefined) this.ips.set(ipKey, [...(this.ips.get(ipKey) ?? []), Date.now()]);
    if (!token) {
      this.record('token');
      try {
        const response = await fetch(`${tdxBase(this.env.TDX_BASE_URL)}${tokenPath}`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: tokenBody({ clientId: this.env.TDX_CLIENT_ID!.trim(), clientSecret: this.env.TDX_CLIENT_SECRET!.trim() }),
        });
        if ([400, 401, 403].includes(response.status)) { console.warn('tdx token authentication failed'); return { ok: false, reason: 'auth' }; }
        if (response.status !== 200) return { ok: false, reason: 'upstream' };
        const data = object(await response.json()), access = string(data.access_token), expiry = data.expires_in ?? 86400;
        if (!access || (data.token_type !== undefined && data.token_type !== 'Bearer') || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) return { ok: false, reason: 'upstream' };
        token = access;
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO tdx_token(id,token,until) VALUES(1,?,?)', token, Date.now() + Math.max(0, expiry - Math.min(60, expiry / 10)) * 1000);
      } catch { return { ok: false, reason: 'upstream' }; }
      // Token fetch may cross a Taipei day/month boundary. Recheck before data.
      const next = this.check(1, purpose);
      if (!next.ok) return next;
    }
    this.record(purpose);
    return { ok: true, token };
  }
  async live(path: string, ipKey: string): Promise<LiveResult> {
    if (!livePath.test(path)) return { ok: false, reason: 'upstream' };
    const now = Date.now();
    for (const [key, value] of this.cache) if (value.until <= now) this.cache.delete(key);
    const cached = this.cache.get(path);
    if (cached) return { ok: true, data: cached.data, fetchedAt: cached.fetchedAt };
    const pending = this.pending.get(path);
    if (pending) return pending;
    const work = (async (): Promise<LiveResult> => {
      try {
        return await this.serial(async () => {
          const admitted = await this.admit('live', ipKey);
          if (!admitted.ok) return admitted;
          try {
            const response = await fetch(tdxApiUrl(path, tdxBase(this.env.TDX_BASE_URL)), {
              headers: { authorization: `Bearer ${admitted.token}` }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
            });
            if (response.status !== 200) {
              if (response.status === 401) this.ctx.storage.sql.exec('DELETE FROM tdx_token');
              return { ok: false, reason: 'upstream' };
            }
            const data = await response.json() as object, fetchedAt = new Date().toISOString();
            const rows = object(data)[path.includes('/TrainLiveBoard/') ? 'TrainLiveBoards' : 'StationLiveBoards'];
            if (!Array.isArray(rows)) return { ok: false, reason: 'upstream' };
            if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(path, { data, fetchedAt, until: Date.now() + 120_000 });
            return { ok: true, data, fetchedAt };
          } catch { return { ok: false, reason: 'upstream' }; }
        });
      } finally { this.pending.delete(path); this.monitor(); }
    })();
    this.pending.set(path, work);
    return work;
  }
  async acquire(purpose: 'snapshot'): Promise<{ ok: true; token: string } | Denied> {
    if (purpose !== 'snapshot') return { ok: false, reason: 'upstream' };
    try { return await this.serial(() => this.admit('snapshot')); }
    finally { this.monitor(); }
  }
  async usage(): Promise<Usage> {
    const now = new Date(), counts = this.counts(now);
    return { ...calendarUsage(now), monthUsed: counts.monthUsed, ...allowance(counts, now),
      pct: Math.round(counts.monthUsed / quota(this.env.TDX_MONTHLY_QUOTA) * 10000) / 100,
      todayUsed: counts.todayUsed, byPurpose: counts.byPurpose, last60s: counts.last60s, updatedAt: now.toISOString() };
  }
  private monitor() {
    this.ctx.waitUntil(this.publish().catch(() => {}));
  }
  private async publish() {
    const record = await this.usage(), fingerprint = JSON.stringify([record.month, record.today, record.monthUsed, record.todayUsed, record.byPurpose]);
    const sql = this.ctx.storage.sql;
    const previous = sql.exec<{ at: number; fingerprint: string }>('SELECT at,fingerprint FROM tdx_monitor WHERE id=1').toArray()[0];
    if (previous?.fingerprint === fingerprint) return;
    if (previous && Date.now() < previous.at + 900_000) {
      await this.ctx.storage.setAlarm(previous.at + 900_000);
      return;
    }
    sql.exec('INSERT OR REPLACE INTO tdx_monitor(id,at,fingerprint) VALUES(1,?,?)', Date.now(), fingerprint);
    await this.env.SNAPSHOTS.put('tdx:usage:v1', JSON.stringify(record));
  }
  async alarm() { await this.publish(); }
}
function calendarUsage(now: Date) { const { month, today } = calendar(now); return { month, today }; }
