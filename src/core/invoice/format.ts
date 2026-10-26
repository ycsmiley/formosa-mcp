import { taipeiParts, type Clock } from '../clock.js';
import { claimPeriod, expectedDrawDate, isClaimable, periodLabel, type Draw } from './parse.js';
import type { CheckResult } from './match.js';
export const formatAmount = (amount: number) => amount >= 10000 ? `${(amount / 10000).toLocaleString('en-US')} 萬元` : `${amount.toLocaleString('en-US')} 元`;
const rocDate = (d: { year: number; month: number; day: number }) => `${d.year}年${String(d.month).padStart(2, '0')}月${String(d.day).padStart(2, '0')}日`;
export function formatWinningNumbers(draw: Draw, clock: Clock): string {
  const claim = claimPeriod(draw.period), date = expectedDrawDate(draw.period);
  return [
    `統一發票中獎號碼｜${periodLabel(draw.period)}`,
    `特別獎：${draw.special}（${formatAmount(10000000)}）`,
    `特獎：${draw.grand}（${formatAmount(2000000)}）`,
    `頭獎：${draw.first.join('、')}（${formatAmount(200000)}）`,
    '二獎～六獎：末7～末3碼對頭獎，獎金依序為 4萬／1萬／4千／1千／200元。',
    '稅：三獎以上扣 20% 所得稅；五獎以上領獎扣 0.4% 印花稅，匯入帳戶免。',
    ...(draw.extraSixth.length ? [`增開六獎：${draw.extraSixth.join('、')}（200 元）`] : []),
    `領獎期間：${rocDate(claim.start)} ～ ${rocDate(claim.end)}${isClaimable(draw.period, clock) ? '（目前可領獎）' : ''}`,
    `開獎日：${rocDate({ ...date, year: date.year - 1911 })}`,
    '資料來源：財政部稅務入口網 https://invoice.etax.nat.gov.tw/',
  ].join('\n');
}
export function formatCheckResult(draw: Draw, result: CheckResult, clock: Clock = () => new Date()): string {
  if (!result.ok) return result.error;
  const prize = result.prize;
  const today = taipeiParts(clock());
  const start = claimPeriod(draw.period).start;
  const beforeClaim = (today.year - 1911) * 10000 + today.month * 100 + today.day < start.year * 10000 + start.month * 100 + start.day;
  const message = prize ? (result.partial && prize.name === '六獎'
    ? `至少中六獎 200 元，請對完整 8 碼看有沒有更大獎（對中 ${prize.matchedNumber}）`
    : `恭喜！中了 ${prize.name}，獎金 ${formatAmount(prize.amount)}（對中 ${prize.matchedNumber}）`) : '沒中';
  return [`【${periodLabel(draw.period)}】${message}`,
    ...(result.partial ? ['只能判斷六獎，大獎要對完整 8 碼。'] : []),
    ...(prize && prize.amount >= 1000 ? [`提醒：${prize.amount >= 10000 ? '三獎以上扣 20% 所得稅；' : ''}五獎以上領獎扣 0.4% 印花稅，匯入帳戶免。`] : []),
    ...(beforeClaim ? [`領獎期間 ${rocDate(start)} 起，還不能領`] : []),
  ].join('\n');
}
