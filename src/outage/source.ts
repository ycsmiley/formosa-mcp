import { taiwater, taipeiwater, taipower } from '../core/outage/normalize.js';
import type { Item, Source } from '../core/outage/model.js';
import { readZip } from './zip.js';
export const urls: Record<Source, string> = {
  taiwater: 'https://web.water.gov.tw/wateroffapi/openData/export/json',
  taipeiwater: 'https://webs.water.gov.taipei/apps/outage.asmx/outageOpenData',
  taipower: 'https://service.taipower.com.tw/data/opendata/apply/file/d077004/001.zip',
};
export const downloadLimit = 16 * 1024 * 1024;
export interface SourceData { items: Item[]; dropped: number; droppedBy?: Record<string, number>; rows: number }
export async function fetchSource(source: Source): Promise<SourceData> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const r = await fetch(urls[source], { signal: controller.signal, redirect: 'follow' });
    if (!r.ok) throw Error(`官方開放資料 HTTP ${r.status}`);
    if (Number(r.headers.get('content-length')) > downloadLimit) { await r.body?.cancel(); throw Error('官方開放資料檔案過大'); }
    if (!r.body) throw Error('官方開放資料缺少內容');
    const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > downloadLimit) { await reader.cancel(); throw Error('官方開放資料檔案過大'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (source === 'taipower') return taipower(readZip(bytes));
    let input: unknown; try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Error('官方開放資料 JSON 格式錯誤'); }
    return source === 'taiwater' ? taiwater(input) : taipeiwater(input);
  } catch (e) { if (controller.signal.aborted) throw Error('官方開放資料連線逾時'); throw e; }
  finally { clearTimeout(timer); }
}
