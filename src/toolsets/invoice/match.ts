import type { Draw } from './parse.js';
export type CheckResult = { ok: false; error: string } | { ok: true; prize: null | { name: string; amount: number; matchedNumber: string }; partial: boolean };
export function checkNumber(input: string, draw: Draw): CheckResult {
  const number = input.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10)).replace(/[\s-]/g, '').replace(/^[A-Za-z]{2}(?=\d)/, '');
  if (!/^\d{3,8}$/.test(number)) return { ok: false, error: '請輸入 3～8 碼發票數字，可加兩碼英文字母（例如 AB-54348835）。' };
  const partial = number.length < 8;
  const win = (name: string, amount: number, matchedNumber: string): CheckResult => ({ ok: true, prize: { name, amount, matchedNumber }, partial });
  if (!partial) {
    if (number === draw.special) return win('特別獎', 10000000, draw.special);
    if (number === draw.grand) return win('特獎', 2000000, draw.grand);
    const names = ['頭獎', '二獎', '三獎', '四獎', '五獎', '六獎'];
    const amounts = [200000, 40000, 10000, 4000, 1000, 200];
    for (let length = 8; length >= 3; length--) {
      const matched = draw.first.find(n => n.slice(-length) === number.slice(-length));
      if (matched) return win(names[8 - length], amounts[8 - length], matched.slice(-length));
    }
  } else {
    const matched = draw.first.find(n => n.slice(-3) === number.slice(-3));
    if (matched) return win('六獎', 200, matched.slice(-3));
  }
  const extra = draw.extraSixth.find(n => n === number.slice(-3));
  return extra ? win('增開六獎', 200, extra) : { ok: true, prize: null, partial };
}
