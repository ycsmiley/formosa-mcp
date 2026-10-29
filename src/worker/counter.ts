import { DurableObject } from 'cloudflare:workers';

/**
 * Memory-only on purpose to avoid the Workers Free row-write quota. State is lost
 * only after idle eviction, when the limit is not being hit. Use one windowMs per
 * object; a future quota that must survive eviction should persist separately.
 */
export class FixedWindowCounter extends DurableObject<unknown> {
  private windowStart = -1;
  private counts = new Map<string, number>();

  async hit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfter: number }> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('key must be a non-empty string');
    }
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error('limit and windowMs must be positive integers');
    }
    const now = Date.now();
    const start = Math.floor(now / windowMs) * windowMs;
    if (start !== this.windowStart) {
      this.counts.clear();
      this.windowStart = start;
    }
    const count = this.counts.get(key) ?? 0;
    if (count >= limit) {
      return { allowed: false, count, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
    }
    this.counts.set(key, count + 1);
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
