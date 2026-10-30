import type { City, Slot, Stop } from './normalize.js';
import { norm } from './text.js';
export interface CityIndex { gen: string; fetchedAt: string; updatedAt: string; capturedWeekday?: number; stops: number; districts: Record<string, { stops: number; sha256: string }> }
export interface Index { v: 2; generatedAt: string; cities: Partial<Record<City, CityIndex>> }
export interface Shard { v: 2; stops: Stop[]; truncated?: boolean }
export const indexKey = 'garbage:index:v2';
export const shardKey = (city: City, gen: string, district: string) => `garbage:v2:${city}:${gen}:${district}`;
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const timestamp = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x));
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
export function decodeIndex(text: string): Index {
  const x: unknown = JSON.parse(text);
  if (!object(x) || x.v !== 2 || !timestamp(x.generatedAt) || !object(x.cities)) throw new Error('Invalid garbage index');
  for (const [city, entry] of Object.entries(x.cities)) {
    if (!['ntpc', 'taipei', 'taichung', 'tainan', 'kaohsiung'].includes(city) || !object(entry) || (typeof entry.gen !== 'string' || !/^[0-9a-z]{1,16}$/.test(entry.gen)) || !timestamp(entry.fetchedAt) || !timestamp(entry.updatedAt) || !count(entry.stops) || !object(entry.districts) || (entry.capturedWeekday !== undefined && (!Number.isInteger(entry.capturedWeekday) || entry.capturedWeekday < 0 || entry.capturedWeekday > 6))) throw new Error('Invalid garbage city');
    for (const [name, district] of Object.entries(entry.districts)) if (!name || !object(district) || !count(district.stops) || typeof district.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(district.sha256)) throw new Error('Invalid garbage district');
  }
  return x as unknown as Index;
}
const validTime = (x: unknown) => typeof x === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x);
type SlotTuple = [number, string, string];
type StopTuple = [string, string, string, SlotTuple[], SlotTuple[], SlotTuple[], string?];
function decodeSlot(x: unknown): Slot {
  if (!Array.isArray(x) || x.length !== 3 || !Number.isInteger(x[0]) || x[0] < 1 || x[0] > 127 || !validTime(x[1]) || !(x[2] === '' || validTime(x[2]))) throw new Error('Invalid garbage slot');
  return { days: x[0], start: x[1], end: x[2] };
}
export function decodeShard(text: string, district: string, keyword?: string): Shard {
  const [header, ...lines] = text.split('\n');
  const x: unknown = JSON.parse(header);
  if (!object(x) || x.v !== 2) throw new Error('Invalid garbage shard');
  const needle = keyword ? norm(keyword) : '';
  const checkLine = !needle.includes('"') && !needle.includes('\\');
  const stops: Stop[] = [];
  for (const line of lines) {
    if (needle) {
      if (checkLine && !norm(line).includes(needle)) continue;
      const fields = /^\["((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"/.exec(line);
      if (!fields || !fields.slice(1).some(field => norm(field.includes('\\') ? JSON.parse(`"${field}"`) : field).includes(needle))) continue;
      if (stops.length === 200) return { v: 2, stops, truncated: true };
    }
    const s: unknown = JSON.parse(line);
    if (!Array.isArray(s) || s.length < 6 || s.length > 7 || typeof s[0] !== 'string' || typeof s[1] !== 'string' || typeof s[2] !== 'string' || !s[2] || (s[6] !== undefined && typeof s[6] !== 'string') || !Array.isArray(s[3]) || !Array.isArray(s[4]) || !Array.isArray(s[5])) throw new Error('Invalid garbage stop');
    stops.push({ district, village: s[0], route: s[1], name: s[2], garbage: s[3].map(decodeSlot), recycling: s[4].map(decodeSlot), food: s[5].map(decodeSlot), ...(s[6] === undefined ? {} : { note: s[6] }) });
  }
  return { v: 2, stops };
}
export function encodeIndex(index: Index): string { const s = JSON.stringify(index); decodeIndex(s); return s; }
export function encodeShard(shard: Shard): string {
  const slots = (items: Slot[]): SlotTuple[] => items.map(s => [s.days, s.start, s.end]);
  const stops: StopTuple[] = shard.stops.map(s => s.note === undefined ? [s.village, s.route, s.name, slots(s.garbage), slots(s.recycling), slots(s.food)] : [s.village, s.route, s.name, slots(s.garbage), slots(s.recycling), slots(s.food), s.note]);
  const text = [JSON.stringify({ v: 2 }), ...stops.map(stop => JSON.stringify(stop))].join('\n'); decodeShard(text, shard.stops[0]?.district ?? ''); return text;
}
