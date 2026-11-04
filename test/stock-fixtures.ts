import { readFileSync } from 'node:fs';
import { marketUrls, stockUrls } from '../src/core/stock/source.js';
export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/stock/${name.replaceAll('-', '_')}.json`, import.meta.url), 'utf8'));
export const stockFetch = async (url: string) => {
  const key = Object.entries(stockUrls).find(([, value]) => value === url)?.[0];
  if (!key) throw new Error(`Unknown URL ${url}`);
  return fixture(key);
};

export const marketInput = () => {
  const headers = fixture('market-headers') as Record<string, Record<string, string>>;
  return { fmtqik: fixture('market-fmtqik'), margn: fixture('market-margn'),
    fmtqikLastModified: headers.fmtqik['last-modified'], margnLastModified: headers.margn['last-modified'],
    tpexIndex: fixture('market-tpex-index'), tpexMargin: fixture('market-tpex-margin'), fetchedAt: '2026-11-04T04:20:00.000Z' };
};
export const marketFixtureFeed = async (url: string) => {
  const key = Object.entries(marketUrls).find(([, value]) => value === url)?.[0] as keyof typeof marketUrls;
  if (!key) throw new Error('unknown market URL');
  const input = marketInput();
  return { body: input[key], lastModified: (fixture('market-headers') as Record<string, Record<string, string>>)[key]['last-modified'] };
};
