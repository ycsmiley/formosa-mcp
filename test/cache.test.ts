import { expect, it, vi } from 'vitest';
import { TtlCache } from '../src/lib/cache.js';
it('deduplicates in-flight loads and expires at TTL', async () => {
  let now = 0;
  const cache = new TtlCache<number>(100, () => now);
  const loader = vi.fn(async () => 42);
  const a = cache.getOrLoad('key', loader), b = cache.getOrLoad('key', loader);
  expect(a).toBe(b);
  expect(await a).toBe(42);
  now = 99;
  await cache.getOrLoad('key', loader);
  expect(loader).toHaveBeenCalledTimes(1);
  now = 100;
  await cache.getOrLoad('key', loader);
  expect(loader).toHaveBeenCalledTimes(2);
});
it('does not cache rejections, including synchronous throws', async () => {
  const cache = new TtlCache<number>();
  await expect(cache.getOrLoad('k', () => { throw new Error('failed'); })).rejects.toThrow('failed');
  expect(await cache.getOrLoad('k', async () => 1)).toBe(1);
});
it('defaults to six hours', async () => {
  let now = 0;
  const cache = new TtlCache<number>(undefined, () => now);
  const loader = vi.fn(async () => 1);
  await cache.getOrLoad('k', loader);
  now = 6 * 60 * 60 * 1000 - 1;
  await cache.getOrLoad('k', loader);
  expect(loader).toHaveBeenCalledTimes(1);
  now++;
  await cache.getOrLoad('k', loader);
  expect(loader).toHaveBeenCalledTimes(2);
});
