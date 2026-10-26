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

const partialNote = '只能判斷六獎，大獎要對完整 8 碼。';
const partialWin = '【115年07-08月】至少中六獎 200 元，請對完整 8 碼看有沒有更大獎（對中 835）';
const previousMiss = '【115年05-06月】沒中';

it.each(['835', '8835', '48835', '348835', '4348835', ' AB-８３５ '])('appends one final partial note across two periods for %s', async number => {
  const service = createInvoiceService({ fetchFeed: async () => xml, clock });
  const reply = await service.check(number);
  expect(reply.isError).toBe(false);
  expect(reply.text).toBe(`${partialWin}\n\n${previousMiss}\n\n${partialNote}`);
  expect(reply.text.split(partialNote)).toHaveLength(2);
  expect(reply.text).toBe(reply.text.trim());
  expect(reply.text).not.toContain('\n\n\n');
});

it.each(['11507', '11505'])('appends one final partial note with explicit period %s', async period => {
  const service = createInvoiceService({ fetchFeed: async () => xml, clock });
  const reply = await service.check('835', period);
  expect(reply.text).toBe(`${period === '11507' ? partialWin : previousMiss}\n\n${partialNote}`);
  expect(reply.text.split(partialNote)).toHaveLength(2);
  expect(reply.text).toBe(reply.text.trim());
  expect(reply.text).not.toContain('\n\n\n');
});

it.each([undefined, '11507'])('formats an eight-digit win and tax reminder without a partial note (period %s)', async period => {
  const service = createInvoiceService({ fetchFeed: async () => xml, clock });
  const reply = await service.check('54348835', period);
  const win = '【115年07-08月】恭喜！中了 頭獎，獎金 20 萬元（對中 54348835）\n提醒：三獎以上扣 20% 所得稅；五獎以上領獎扣 0.4% 印花稅，匯入帳戶免。';
  expect(reply.text).toBe(period ? win : `${win}\n\n${previousMiss}`);
  expect(reply.text).not.toContain(partialNote);
  expect(reply.text).toBe(reply.text.trim());
  expect(reply.text).not.toContain('\n\n\n');
});
