import { DurableObject } from 'cloudflare:workers';

export class FixedWindowCounter extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)');
    // No start index: save write quota; pruning scans only the shard's window-bounded keys.
  }

  async hit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfter: number }> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('key must be a non-empty string');
    }
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error('limit and windowMs must be positive integers');
    }
    const now = Date.now();
    const start = Math.floor(now / windowMs) * windowMs;
    const sql = this.ctx.storage.sql;
    // All keys in one object must use the same windowMs so this prunes only expired rows.
    sql.exec('DELETE FROM counters WHERE start < ?', start);
    const [state] = sql.exec<{ start: number; count: number }>('SELECT start, count FROM counters WHERE key = ?', key).toArray();
    const count = state?.start === start ? state.count : 0;
    if (count >= limit) {
      return { allowed: false, count, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
    }
    sql.exec('INSERT INTO counters (key, start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET start = excluded.start, count = excluded.count', key, start, count + 1);
    return { allowed: true, count: count + 1, retryAfter: 0 };
  }
}

export function hitCounter(ns: DurableObjectNamespace<FixedWindowCounter>, shard: string, key: string, limit: number, windowMs: number) {
  return ns.get(ns.idFromName(shard)).hit(key, limit, windowMs);
}

export function ipShard(ip: string, shards = 16): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) {
    hash = Math.imul(hash ^ ip.charCodeAt(i), 0x01000193);
  }
  return `mcp-ip-${(hash >>> 0) % shards}`;
}
