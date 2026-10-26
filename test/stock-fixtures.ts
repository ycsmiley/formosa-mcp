import { readFileSync } from 'node:fs';
import { stockUrls } from '../src/core/stock/source.js';
export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/stock/${name.replaceAll('-', '_')}.json`, import.meta.url), 'utf8'));
export const stockFetch = async (url: string) => {
  const key = Object.entries(stockUrls).find(([, value]) => value === url)?.[0];
  if (!key) throw new Error(`Unknown URL ${url}`);
  return fixture(key);
};
