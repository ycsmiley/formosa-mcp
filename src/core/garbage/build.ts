import { normalize, type City } from './normalize.js';
import { encodeShard, type CityIndex } from './snapshot.js';
export async function buildCity(city: City, input: string, now: Date): Promise<{ entry: CityIndex; shards: Map<string, string> }> {
  const stops = normalize(city, input, now), groups = new Map<string, typeof stops>();
  for (const stop of stops) { const group = groups.get(stop.district) ?? []; group.push(stop); groups.set(stop.district, group); }
  const shards = new Map<string, string>(), districts: CityIndex['districts'] = {};
  for (const [district, group] of groups) { const value = encodeShard({ v: 2, stops: group }); shards.set(district, value); districts[district] = { stops: group.length, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('') }; }
  const date = now.toISOString();
  return { entry: { gen: now.getTime().toString(36), fetchedAt: date, updatedAt: date, stops: stops.length, districts }, shards };
}
