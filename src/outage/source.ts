import { taiwater, taipeiwater, taipower } from '../core/outage/normalize.js';
import type { Item, Source } from '../core/outage/model.js';
import { readZip } from './zip.js';
export const urls: Record<Source, string> = {
  taiwater: 'https://web.water.gov.tw/wateroffapi/openData/export/json',
  taipeiwater: 'https://webs.water.gov.taipei/apps/outage.asmx/outageOpenData',
  taipower: 'https://service.taipower.com.tw/data/opendata/apply/file/d077004/001.zip',
};
export interface SourceData { items: Item[]; dropped: number; rows: number }
export async function fetchSource(source: Source): Promise<SourceData> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const r = await fetch(urls[source], { signal: controller.signal, redirect: 'follow' });
    if (!r.ok) throw Error(`官方開放資料 HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer()); if (bytes.length > 32 * 1024 * 1024) throw Error('官方開放資料檔案過大');
    if (source === 'taipower') return taipower(readZip(bytes));
    let input: unknown; try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Error('官方開放資料 JSON 格式錯誤'); }
    const items = source === 'taiwater' ? taiwater(input) : taipeiwater(input);
    return { items, dropped: 0, rows: (input as unknown[]).length };
  } catch (e) { if (controller.signal.aborted) throw Error('官方開放資料連線逾時'); throw e; }
  finally { clearTimeout(timer); }
}
