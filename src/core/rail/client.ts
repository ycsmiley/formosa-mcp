import type { Clock } from '../clock.js';

export interface RailHttpResponse { status: number; json(): Promise<unknown> }
export type RailHttp = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<RailHttpResponse>;
export interface RailCredentials { clientId: string; clientSecret: string }
export const unavailable = 'TDX 服務暫時無法使用，請稍後再試';
export const rejected = 'TDX 金鑰驗證失敗，請確認 TDX_CLIENT_ID／TDX_CLIENT_SECRET';
export const railRowLimit = 1000;
export const truncatedNote = '資料可能未完整（已達單次上限）';
export class RailError extends Error {}
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new RailError(unavailable); return value; };

export const defaultTdxBase = 'https://tdx.transportdata.tw';
export const tokenPath = '/auth/realms/TDXConnect/protocol/openid-connect/token';
export function tdxBase(value?: string): string {
  try {
    const url = new URL(value ?? '');
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password) return url.origin;
  } catch { /* Only loopback demos may override the production origin. */ }
  return defaultTdxBase;
}
export function tdxApiUrl(path: string, base = defaultTdxBase, query: Record<string, string> = {}) {
  return `${base}/api/basic${path}?$format=JSON&$top=${railRowLimit}${Object.entries(query).map(([key, value]) => `&${key}=${encodeURIComponent(value)}`).join('')}`;
}
export function tokenBody(credentials: RailCredentials) {
  return new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.clientId, client_secret: credentials.clientSecret }).toString();
}
export function createTdxClient(credentials: RailCredentials, http: RailHttp, clock: Clock, options: { baseUrl?: string; query?: Record<string, string> } = {}) {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  async function request(url: string, init: Parameters<RailHttp>[1]) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined;
      return await http(url, { ...init, signal });
    } catch { throw new RailError(unavailable); }
  }
  async function token(): Promise<string> {
    if (cached && clock().getTime() < cached.until) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const response = await request(`${tdxBase(options.baseUrl)}${tokenPath}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody(credentials),
      });
      if ([400, 401, 403].includes(response.status)) throw new RailError(rejected);
      if (response.status !== 200) throw new RailError(unavailable);
      const data = object(await response.json());
      const access = string(data.access_token);
      if (!access || (data.token_type !== undefined && data.token_type !== 'Bearer')) throw new RailError(unavailable);
      const expiry = data.expires_in === undefined ? 86400 : data.expires_in;
      if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) throw new RailError(unavailable);
      cached = { token: access, until: clock().getTime() + Math.max(0, expiry - Math.min(60, expiry / 10)) * 1000 };
      return access;
    })();
    try { return await pending; }
    catch (error) { throw error instanceof RailError ? error : new RailError(unavailable); }
    finally { pending = undefined; }
  }
  return {
    async get(path: string): Promise<unknown> {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const access = await token();
          const response = await request(tdxApiUrl(path, tdxBase(options.baseUrl), options.query), { headers: { authorization: `Bearer ${access}` } });
          if (response.status === 401 && attempt === 0) {
            // A concurrent 401 for an older token must not invalidate its replacement.
            if (cached?.token === access) cached = undefined;
            continue;
          }
          if (response.status !== 200) throw new RailError(unavailable);
          return await response.json();
        }
        throw new RailError(unavailable);
      } catch (error) { throw error instanceof RailError ? error : new RailError(unavailable); }
    },
  };
}
