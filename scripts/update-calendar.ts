import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const metadataUrl = 'https://data.gov.tw/api/v2/rest/dataset/14718';
const openUrl = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
const twseUrl = (year: number) => `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?date=${year}0101&response=json`;
const trading = (name: string) => /開始交易|最後交易/.test(name);
const iso = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
export function defaultYears(today = new Date()): number[] {
  const current = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(today)) - 1911;
  return [current, current + 1];
}
export function parseCsv(csv: string, year: number) {
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (lines.shift() !== '西元日期,星期,是否放假,備註') throw Error('辦公日曆欄位不正確');
  const notes: Record<string, string> = {}; let days = '';
  const count = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  if (lines.length !== count) throw Error(`${year} 年辦公日曆日期數量不正確`);
  lines.forEach((line, i) => {
    const match = line.match(/^(\d{8}),([^,]*),([^,]*),(.*)$/);
    const expected = new Date(Date.UTC(year, 0, 1 + i)).toISOString().slice(0, 10);
    if (!match || iso(match[1]) !== expected || !/^[02]$/.test(match[3])) throw Error(`${year} 年辦公日曆第 ${i + 1} 筆日期或放假代碼錯誤`);
    days += match[3]; if (match[4]) notes[expected] = match[4].replace(/^"|"$/g, '').replace(/""/g, '"');
  });
  return { days, notes };
}
export async function generate(options: { years: number[]; inputDir?: string; fetched: string }) {
  const get = async (name: string, url: string) => {
    if (options.inputDir) return readFile(resolve(options.inputDir, name), 'utf8');
    const response = await fetch(url); if (!response.ok) throw Error(`下載失敗 ${url}：HTTP ${response.status}`); return response.text();
  };
  const metadata = JSON.parse(await get('datagov-14718.json', metadataUrl));
  const open = JSON.parse(await get('twse-openapi.json', openUrl));
  if (!Array.isArray(open)) throw Error('證交所 OpenAPI 格式錯誤');
  const result: Record<string, unknown> = {};
  for (const roc of options.years) {
    const year = roc + 1911;
    const resources = metadata.result.distribution.filter((r: any) => r.resourceDescription.startsWith(`${roc}年`) && !/google/i.test(r.resourceDescription) && String(r.resourceFormat).toUpperCase() === 'CSV' && /dgpa\/files\/\d{6}\//i.test(r.resourceDownloadUrl)).sort((a: any, b: any) => b.resourceDownloadUrl.match(/dgpa\/files\/(\d{6})\//i)[1].localeCompare(a.resourceDownloadUrl.match(/dgpa\/files\/(\d{6})\//i)[1]));
    const resource = resources[0]; if (!resource) throw Error(`找不到民國 ${roc} 年辦公日曆資源；若次年資料尚未公布，可用 --years ${defaultYears()[0]} 僅更新今年`);
    const month = resource.resourceDownloadUrl.match(/dgpa\/files\/(\d{4})(\d{2})\//i);
    const office = parseCsv(await get(`dgpa-${roc}.csv`, resource.resourceDownloadUrl), year);
    const market = JSON.parse(await get(`twse-rwd-${year}.json`, twseUrl(year)));
    if (market.stat?.toLowerCase() !== 'ok' || !Array.isArray(market.data)) throw Error(`${year} 年證交所資料格式錯誤`);
    const entries: [string, string, boolean][] = market.data.map((row: unknown) => {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row[0]) || !row[0].startsWith(`${year}-`) || !Number.isFinite(Date.parse(row[0])) || new Date(row[0]).toISOString().slice(0, 10) !== row[0] || typeof row[1] !== 'string') throw Error(`${year} 年證交所日期或名稱錯誤`);
      return [row[0], row[1], trading(row[1])];
    });
    const subset = open.filter((row: any) => String(row.Date).startsWith(String(roc)));
    if (subset.length) {
      const a = [...new Set(entries.map(([d, , t]) => `${d}:${t}`))].sort();
      const b = [...new Set<string>(subset.map((r: any) => `${iso(String(Number(String(r.Date).slice(0, 3)) + 1911) + String(r.Date).slice(3))}:${trading(r.Name)}`))].sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${year} 年證交所 RWD 與 OpenAPI 開休市日期不一致`);
    }
    result[year] = { ...office, entries, source: { title: resource.resourceDescription, url: resource.resourceDownloadUrl, published: `${month[1]}-${month[2]}`, twse: twseUrl(year), fetched: options.fetched } };
  }
  return `// Generated; do not edit. Regenerate with npm run update:calendar; update yearly via PR.\nexport const data = ${JSON.stringify(result, null, 2)} as const;\n`;
}
export async function main(args = process.argv.slice(2)) {
  const today = new Date();
  const value = (name: string, fallback?: string) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} 缺少參數`); return args[i + 1]; };
  const years = value('--years', defaultYears(today).join(','))!.split(',').map(Number), fetched = value('--fetched', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(today))!;
  if (years.some(y => !Number.isInteger(y) || y < 1) || !/^\d{4}-\d{2}-\d{2}$/.test(fetched) || !Number.isFinite(Date.parse(fetched)) || new Date(fetched).toISOString().slice(0, 10) !== fetched) throw Error('年份或取得日期無效');
  const output = await generate({ years, inputDir: value('--input-dir'), fetched });
  await writeFile('src/core/calendar/data.ts', output);
  console.log(`已產生民國 ${years.join('、')} 年日曆`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(`日曆更新失敗：${e.message}`); process.exitCode = 1; });
