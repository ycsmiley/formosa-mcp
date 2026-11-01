import type { Item } from './model.js';
export function buildShards(items: Item[]): Map<string, string> {
  const counties = new Map<string, Item[]>();
  for (const item of items) { const rows = counties.get(item.c) ?? []; rows.push(item); counties.set(item.c, rows); }
  return new Map([...counties].sort(([a], [b]) => a.localeCompare(b)).map(([c, rows]) => [c, JSON.stringify(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))]));
}
