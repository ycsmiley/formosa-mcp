import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createInvoiceService, TtlCache, type Draw } from '../src/core/index.js';
const xml = readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8');
const clock = () => new Date('2026-10-26T00:00:00+08:00');

it('uses an injected cache across plain service calls', async () => {
  const fetchFeed = vi.fn(async () => xml);
  const cache = new TtlCache<Draw[]>(100, () => 0);
  const getOrLoad = vi.spyOn(cache, 'getOrLoad');
  const service = createInvoiceService({ fetchFeed, clock, cache });
  expect(await service.getWinningNumbers()).toMatchObject({ text: expect.stringContaining('統一發票中獎號碼｜115年07-08月'), isError: false });
  expect(await service.check('54348835')).toMatchObject({ text: expect.stringContaining('恭喜！中了 頭獎'), isError: false });
  expect(getOrLoad).toHaveBeenCalledTimes(2);
  expect(fetchFeed).toHaveBeenCalledTimes(1);
});

it('validates plain service inputs before fetching', async () => {
  const fetchFeed = vi.fn(async () => xml);
  const service = createInvoiceService({ fetchFeed, clock });
  expect(await service.getWinningNumbers('bad')).toMatchObject({ isError: true });
  expect(await service.check('12')).toMatchObject({ isError: true });
  expect(fetchFeed).not.toHaveBeenCalled();
});
