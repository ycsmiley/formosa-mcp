import { taipeiParts } from '../core/clock.js';
import type { TpexCheck } from '../core/stock/service.js';
import type { Env } from './index.js';
import { collectKeys } from './snapshot-keys.js';
export async function readTpexCheck(env: Env): Promise<TpexCheck | undefined> {
  try {
    const data = JSON.parse(await env.SNAPSHOTS.get(collectKeys.tpex) ?? 'null');
    if (data?.v !== 1 || typeof data.lastSuccessAt !== 'string' || typeof data.dataDate !== 'string') return;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.lastSuccessAt) || !Number.isFinite(Date.parse(data.lastSuccessAt))) return;
    if ([data.dataDate, data.lastSuccessAt.slice(0, 10)].some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)) return;
    return { lastSuccessAt: data.lastSuccessAt, dataDate: data.dataDate };
  } catch { /* Missing or invalid collector state does not affect quotes. */ }
}
export async function tpexFallback(env: Env, scheduledTime: number): Promise<void> {
  try {
    const { year, month, day } = taipeiParts(new Date(scheduledTime));
    const today = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
    if ((await readTpexCheck(env))?.dataDate === today) { console.log('tpex fallback fresh'); return; }
    const token = env.GH_DISPATCH_TOKEN;
    if (!token) { console.log('tpex fallback skip no token'); return; }
    const key = `tpex:fallback:${today}`, count = Number(await env.SNAPSHOTS.get(key) ?? '0');
    if (count >= 2) { console.log('tpex fallback skip cap'); return; }
    await env.SNAPSHOTS.put(key, String(count + 1), { expirationTtl: 259200 });
    const response = await fetch('https://api.github.com/repos/ycsmiley/formosa-mcp/actions/workflows/tpex-collect.yml/dispatches', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    (response.status === 204 ? console.log : console.warn)(`tpex fallback dispatch status=${response.status}`);
    await response.body?.cancel();
  } catch (error) { console.warn(`tpex fallback fail ${error instanceof Error ? error.name : 'error'}`); }
}
