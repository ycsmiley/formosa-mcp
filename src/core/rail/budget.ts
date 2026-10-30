import { taipeiNow } from './time.js';

export type Purpose = 'live' | 'snapshot';
export type BudgetReason = 'minute' | 'daily' | 'monthly' | 'ip' | 'nokey';
export interface Counts {
  monthUsed: number;
  todayUsed: number;
  snapshotToday: number;
  last60s: number;
  ipMisses?: number;
  hasKey?: boolean;
  monthlyQuota?: number;
}
export function calendar(now: Date) {
  const today = taipeiNow(now).date, month = today.slice(0, 7);
  const [year, m, day] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { today, month, daysInMonth, remainingDays: daysInMonth - day + 1 };
}
export function quota(value?: string | number) {
  const n = typeof value === 'string' && !/^\d+$/.test(value) ? NaN : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4500 ? n : 4500;
}
export function allowance(counts: Counts, now: Date) {
  const monthlyQuota = quota(counts.monthlyQuota), liveCeiling = Math.floor(monthlyQuota * 0.9);
  const usedBeforeToday = counts.monthUsed - counts.todayUsed;
  const dailyBudget = Math.max(0, Math.floor((liveCeiling - usedBeforeToday) / calendar(now).remainingDays));
  return { monthlyQuota, liveCeiling, dailyBudget };
}
export function decide(n: number, purpose: Purpose, counts: Counts, now: Date): { ok: true } | { ok: false; reason: BudgetReason } {
  const { monthlyQuota, liveCeiling, dailyBudget } = allowance(counts, now);
  const deny = (reason: BudgetReason) => ({ ok: false as const, reason });
  if (counts.hasKey === false) return deny('nokey');
  if (counts.monthUsed + n > (purpose === 'live' ? liveCeiling : monthlyQuota)) return deny('monthly');
  if (purpose === 'live' && (counts.ipMisses ?? 0) >= 6) return deny('ip');
  if (purpose === 'live' ? counts.todayUsed + n > dailyBudget : counts.snapshotToday + n > 20) return deny('daily');
  if (counts.last60s + n > 4) return deny('minute');
  return { ok: true };
}
