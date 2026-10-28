export interface Validators { etag?: string; lastModified?: string }
export type StockMeta = Record<string, Validators>;
export type FeedResult = { status: 304 } | { status: 200; body: unknown; validators: Validators };

export function decodeStockMeta(value: string | null): StockMeta {
  try {
    const parsed = JSON.parse(value ?? '{}'), meta: StockMeta = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (!item || typeof item !== 'object') continue;
      const { etag, lastModified } = item as Validators;
      if (typeof etag === 'string' || typeof lastModified === 'string') meta[key] = {
        ...(typeof etag === 'string' ? { etag } : {}),
        ...(typeof lastModified === 'string' ? { lastModified } : {}),
      };
    }
    return meta;
  } catch { return {}; }
}

export function conditionalHeaders(validators: Validators = {}): Record<string, string> {
  return {
    ...(validators.etag ? { 'If-None-Match': validators.etag } : {}),
    ...(validators.lastModified ? { 'If-Modified-Since': validators.lastModified } : {}),
  };
}

export async function fetchStockFeed(feed: string, url: string, validators?: Validators, { retryDelayMs = 1500 } = {}): Promise<FeedResult> {
  const started = Date.now(), deadline = started + 45_000, signal = AbortSignal.timeout(45_000);
  const headers = { 'User-Agent': 'formosa-mcp (+https://github.com/ycsmiley/formosa-mcp)', Accept: 'application/json', ...conditionalHeaders(validators) };
  const { host, pathname } = new URL(url);
  // Error messages and upstream bodies may echo a URL; keep its query out of logs too.
  const clean = (text: string) => text.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g, '$1').replace(/\s+/g, ' ').trim();
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined, retryable = false;
    try {
      try { response = await fetch(url, { signal, headers }); }
      catch (error) { retryable = true; throw error; }
      if (response.status === 304) return { status: 304 };
      if (response.status !== 200) {
        retryable = response.status === 429 || response.status >= 500 && response.status <= 599;
        throw new Error(`HTTP ${response.status}`);
      }
      const etag = response.headers.get('ETag'), lastModified = response.headers.get('Last-Modified');
      return { status: 200, body: await response.json(), validators: {
        ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}),
      } };
    } catch (error) {
      if (attempt === 0 && retryable && !signal.aborted && Date.now() + retryDelayMs < deadline) {
        await response?.body?.cancel().catch(() => {});
        if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(retryDelayMs, Math.max(0, deadline - Date.now()))));
        if (!signal.aborted && Date.now() < deadline) continue;
      }
      let detail: string;
      if (response && response.status !== 200) {
        let body = '';
        try { body = clean(await response.text()).slice(0, 200); } catch { /* Diagnostics must not hide the HTTP failure. */ }
        detail = `status=${response.status} body=${JSON.stringify(body)}`;
      } else detail = `error=${clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`;
      console.warn(`stock feed fail ${feed.split('-')[0]} ${feed} ${host}${pathname} ${detail} ms=${Date.now() - started}`);
      throw error;
    }
  }
}
