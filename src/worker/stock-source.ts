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

export async function fetchStockFeed(url: string, validators?: Validators): Promise<FeedResult> {
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000), headers: conditionalHeaders(validators) });
  if (response.status === 304) return { status: 304 };
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const etag = response.headers.get('ETag'), lastModified = response.headers.get('Last-Modified');
  return { status: 200, body: await response.json(), validators: {
    ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}),
  } };
}
