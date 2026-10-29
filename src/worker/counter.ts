import { DurableObject } from 'cloudflare:workers';

/** IPv6 clients share a /64; IPv4 octets accept leading zeros and normalize as decimal. */
export function rateLimitKey(ip: string | null | undefined): string {
  try {
    if (typeof ip !== 'string') return 'unknown';
    ip = ip.trim();
    if (!ip) return 'unknown';
    const ipv4 = (value: string): string | undefined => {
      const octets = value.split('.');
      if (octets.length !== 4 || octets.some(octet => !octet || octet.length > 3 || /\D/.test(octet) || Number(octet) > 255)) return;
      return octets.map(Number).join('.');
    };
    if (!ip.includes(':')) return ipv4(ip) ?? 'unknown';
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);

    let mapped: string | undefined;
    if (ip.includes('.')) {
      const lastColon = ip.lastIndexOf(':');
      mapped = ipv4(ip.slice(lastColon + 1));
      if (!mapped) return 'unknown';
      // The dotted tail occupies two hextets; only IPv4-mapped prefixes are allowed.
      ip = `${ip.slice(0, lastColon + 1)}0:0`;
    }
    const halves = ip.split('::');
    if (halves.length > 2) return 'unknown';
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = [...left, ...right];
    if (groups.some(group => !group || group.length > 4 || /[^0-9a-f]/i.test(group))) return 'unknown';
    if (halves.length === 1 ? groups.length !== 8 : groups.length >= 8) return 'unknown';
    const expanded = [...left, ...Array(8 - groups.length).fill('0'), ...right].map(group => parseInt(group, 16).toString(16));
    if (expanded.slice(0, 5).every(group => group === '0') && expanded[5] === 'ffff') {
      return mapped ?? expanded.slice(6).flatMap(group => {
        const value = parseInt(group, 16);
        return [value >>> 8, value & 255];
      }).join('.');
    }
    if (mapped) return 'unknown';
    return `${expanded.slice(0, 4).join(':')}::/64`;
  } catch {
    return 'unknown';
  }
}

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
