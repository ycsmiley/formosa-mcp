import { taipeiNow } from './time.js';

export type BudgetReason = 'minute' | 'daily' | 'monthly' | 'ip' | 'nokey';
export interface Counts {
  monthUsed: number;
  todayUsed: number;
  collectorUsed?: number;
  snapshotReserve?: number;
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
export function snapshotReserve(value?: string, monthlyQuota = 4500) {
  const n = value === undefined || value.trim() === '' ? 200 : Number(value);
  return Math.min(quota(monthlyQuota), Math.max(0, Number.isFinite(n) ? Math.floor(n) : 200));
}
export function allowance(counts: Counts, now: Date) {
  const monthlyQuota = quota(counts.monthlyQuota);
  const reserve = snapshotReserve(counts.snapshotReserve?.toString(), monthlyQuota);
  const snapshotReported = Number.isSafeInteger(counts.collectorUsed) && counts.collectorUsed! >= 0 ? counts.collectorUsed! : 0;
  // Live gets 90% of quota minus max(reserve, collector use); spread the rest over remaining days.
  const liveCeiling = Math.max(0, Math.floor(monthlyQuota * 0.9) - Math.max(reserve, snapshotReported));
  const usedBeforeToday = counts.monthUsed - counts.todayUsed;
  const dailyBudget = Math.max(0, Math.floor((liveCeiling - usedBeforeToday) / calendar(now).remainingDays));
  return { monthlyQuota, snapshotReserve: reserve, snapshotReported, liveCeiling, dailyBudget };
}
export function decide(n: number, counts: Counts, now: Date): { ok: true } | { ok: false; reason: BudgetReason } {
  const { liveCeiling, dailyBudget } = allowance(counts, now);
  const deny = (reason: BudgetReason) => ({ ok: false as const, reason });
  if (counts.hasKey === false) return deny('nokey');
  if (counts.monthUsed + n > liveCeiling) return deny('monthly');
  if ((counts.ipMisses ?? 0) >= 6) return deny('ip');
  if (counts.todayUsed + n > dailyBudget) return deny('daily');
  if (counts.last60s + n > 4) return deny('minute');
  return { ok: true };
}
