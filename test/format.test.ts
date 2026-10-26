import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { formatAmount, formatCheckResult, formatWinningNumbers } from '../src/toolsets/invoice/format.js';
import { parseInvoiceFeed } from '../src/toolsets/invoice/parse.js';
import { checkNumber } from '../src/toolsets/invoice/match.js';
const draw = parseInvoiceFeed(readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8'))[0];
const clock = () => new Date('2026-10-26T00:00:00+08:00');
it('formats winning numbers and claim period without an empty extra prize line', () => {
  const value = formatWinningNumbers(draw, clock);
  expect(value).toContain('特別獎：89996565');
  expect(value).toContain('領獎期間：115年10月06日 ～ 116年01月05日');
  expect(value).toContain('開獎日：115年09月25日');
  expect(value).not.toContain('增開六獎');
  expect(formatWinningNumbers({ ...draw, extraSixth: ['123'] }, clock)).toContain('增開六獎：123');
});
it.each([[10000000, '1,000 萬元'], [2000000, '200 萬元'], [200000, '20 萬元'], [40000, '4 萬元'], [10000, '1 萬元'], [4000, '4,000 元'], [1000, '1,000 元'], [200, '200 元']])('formats %i', (amount, text) => expect(formatAmount(amount)).toBe(text));
it('explains partial wins and tax threshold', () => {
  const partial = formatCheckResult(draw, checkNumber('835', draw));
  expect(partial).toContain('至少中六獎 200 元，請對完整 8 碼看有沒有更大獎');
  expect(partial).toContain('只能判斷六獎，大獎要對完整 8 碼');
  expect(formatCheckResult(draw, checkNumber('00348835', draw))).toContain('三獎以上扣 20% 所得稅');
  expect(formatCheckResult(draw, checkNumber('00048835', draw))).not.toContain('所得稅');
});
it('keeps all formatted result types clean and human-readable', () => {
  const extraDraw = { ...draw, extraSixth: ['123'] };
  const values = [formatWinningNumbers(draw, clock), formatWinningNumbers(extraDraw, clock),
    ...['89996565', '91098182', '54348835', '04348835', '00348835', '00048835', '00008835', '00000835', '00000123', '00000000', '835', '48835', '123', '999', 'bad'].map(n => formatCheckResult(extraDraw, checkNumber(n, extraDraw)))];
  for (const value of values) {
    expect(value).not.toMatch(/undefined|null|\[object Object\]|NaN/);
    expect(value).not.toContain('{"');
    expect(() => JSON.parse(value)).toThrow();
  }
});
