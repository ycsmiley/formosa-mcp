import { expect, it } from 'vitest';
import { checkNumber } from '../src/core/invoice/match.js';
import type { Draw } from '../src/core/invoice/parse.js';
const draw: Draw = { period: { rocYear: 115, evenMonth: 8 }, special: '89996565', grand: '91098182', first: ['54348835', '44991397', '06595111'], extraSixth: ['123'] };
it.each([
  ['89996565', '特別獎', 10000000], ['91098182', '特獎', 2000000], ['54348835', '頭獎', 200000],
  ['04348835', '二獎', 40000], ['00348835', '三獎', 10000], ['00048835', '四獎', 4000],
  ['00008835', '五獎', 1000], ['00000835', '六獎', 200], ['00000123', '增開六獎', 200],
  ['AB-54348835', '頭獎', 200000], ['AB54348835', '頭獎', 200000], [' 5434-8835 ', '頭獎', 200000],
])('checks %s as highest prize %s', (input, name, amount) => expect(checkNumber(input, draw)).toMatchObject({ ok: true, partial: false, prize: { name, amount } }));
it.each(['835', '48835', '4348835', '８３５'])('partial match %s', input => expect(checkNumber(input, draw)).toMatchObject({ ok: true, partial: true, prize: { name: '六獎', amount: 200 } }));
it.each(['123', '１２３'])('partial extra sixth %s', input => expect(checkNumber(input, draw)).toMatchObject({ ok: true, partial: true, prize: { name: '增開六獎' } }));
it.each(['00000000', '999'])('miss %s', input => expect(checkNumber(input, draw)).toEqual({ ok: true, prize: null, partial: input.length < 8 }));
it.each(['', '12', '123456789', '12a45678', 'ABC12345678'])('invalid %s', input => {
  const result = checkNumber(input, draw);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(/請輸入/);
});
