export type City = 'ntpc' | 'taipei' | 'taichung';
export interface Slot { days: number; start: string; end: string }
export interface Stop { district: string; village: string; route: string; name: string; garbage: Slot[]; recycling: Slot[]; food: Slot[]; note?: string }

type Row = Record<string, unknown>;
const str = (value: unknown) => String(value ?? '').trim();
export function time(value: unknown): string {
  const s = str(value).replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10));
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m || +m[1] > 23 || +m[2] > 59) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Parse RFC 4180 CSV, including escaped quotes and embedded newlines. */
export function parseCsv(input: string): Row[] {
  input = input.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('Invalid CSV: unclosed quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ''])));
}
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function flags(row: Row, prefix: string): number {
  return weekdays.reduce((mask, day, i) => mask | (str(row[prefix + day]).toUpperCase() === 'Y' ? 1 << i : 0), 0);
}
function dayText(value: unknown): number {
  const s = str(value); if (s.includes('無清運')) return 0;
  return [...s].reduce((mask, c) => { const i = '日一二三四五六'.indexOf(c === '天' ? '日' : c); return i < 0 ? mask : mask | 1 << i; }, 0);
}
function one(days: number, start: string, end = ''): Slot[] { return days && start ? [{ days, start, end }] : []; }
function daily(row: Row, prefix: string): Slot[] {
  const result: Slot[] = [];
  for (let d = 1; d <= 7; d++) {
    const start = time(row[`${prefix}_d${d}_time_s`]);
    if (!start) continue;
    const end = time(row[`${prefix}_d${d}_time_e`]);
    const slot = result.find(s => s.start === start && s.end === end);
    if (slot) slot.days |= 1 << (d % 7); else result.push({ days: 1 << (d % 7), start, end });
  }
  return result;
}
export function normalize(city: City, input: string, capturedAt: Date): Stop[] {
  const parsed = city === 'ntpc' || city === 'taipei' ? parseCsv(input) : JSON.parse(input);
  const rows: unknown = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(rows)) throw new Error('Invalid source data');
  const output: Stop[] = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Row; let stop: Stop;
    if (city === 'ntpc') {
      const start = time(r.time);
      stop = { district: str(r.city), village: str(r.village), route: str(r.linename), name: str(r.name), garbage: one(flags(r, 'garbage'), start), recycling: one(flags(r, 'recycling'), start), food: one(flags(r, 'foodscraps'), start), ...(str(r.memo) && str(r.memo) !== '-' ? { note: str(r.memo) } : {}) };
    } else if (city === 'taipei') {
      const start = time(r['抵達時間']), end = time(r['離開時間']);
      const recyclingDays = /每週([一二三四五六日](?:[,、]?[一二三四五六日])*)回收/.exec(str(r['地點']));
      const recyclingOnly = str(r['地點']).includes('回收車');
      stop = { district: str(r['行政區']), village: str(r['里別']), route: `${str(r['路線'])} ${str(r['車次'])}`.trim(), name: str(r['地點']), garbage: recyclingOnly ? [] : one(118, start, end), recycling: one(recyclingDays ? dayText(recyclingDays[1]) : 118, start, end), food: recyclingOnly ? [] : one(118, start, end), ...(recyclingOnly ? { note: '僅資源回收車收運' } : {}) };
    } else {
      if (str(r.task_type) === '往廠') continue;
      stop = { district: str(r.area), village: str(r.village), route: str(r.car_licence), name: str(r.caption), garbage: daily(r, 'g'), recycling: daily(r, 'r'), food: [] };
    }
    if (!stop.district || !stop.name || ![...stop.garbage, ...stop.recycling, ...stop.food].length) continue;
    output.push(stop);
  }
  return output;
}
