import type { City } from '../core/garbage/normalize.js';
export const urls: Record<City, string> = {
  ntpc: 'https://data.ntpc.gov.tw/api/datasets/edc3ad26-8ae7-4916-a00b-bc6048d19bf8/csv/file',
  taipei: 'https://data.taipei/api/dataset/6bb3304b-4f46-4bb0-8cd1-60c66dcd1cae/resource/a6e90031-7ec4-4089-afb5-361a4efe7202/download',
  taichung: 'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=68d1a87f-7baa-4b50-8408-c36a3a7eda68',
};
export async function fetchSource(city: City): Promise<string> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(urls[city], { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'formosa-mcp garbage collector (+https://github.com/ycsmiley/formosa-mcp)' } });
    if (!response.ok || !response.body) throw new Error('source unavailable');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32 * 1024 * 1024) { controller.abort(); throw new Error('source too large'); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  } finally { clearTimeout(timer); }
}
