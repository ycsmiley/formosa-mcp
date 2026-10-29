import { DurableObject } from 'cloudflare:workers';

export class FixedWindowCounter extends DurableObject {
  async hit(limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfter: number }> {
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error('limit and windowMs must be positive integers');
    }
    let state = await this.ctx.storage.get<{ start: number; count: number }>('window');
    const now = Date.now();
    const start = Math.floor(now / windowMs) * windowMs;
    if (!state || state.start !== start) state = { start, count: 0 };
    if (state.count >= limit) {
      return { allowed: false, count: state.count, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
    }
    state.count++;
    await this.ctx.storage.put('window', state);
    return { allowed: true, count: state.count, retryAfter: 0 };
  }
}

export function hitCounter(ns: DurableObjectNamespace<FixedWindowCounter>, name: string, limit: number, windowMs: number) {
  return ns.get(ns.idFromName(name)).hit(limit, windowMs);
}
