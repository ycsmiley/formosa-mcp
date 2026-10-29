import { expect, it, vi } from 'vitest';
import { isStale, matchesFact, parseRocDate, runChecks } from '../scripts/eval-live.js';

it('matches facts after removing spaces and colons', () => {
  expect(matchesFact('特別獎：89996565（1,000 萬元）', '特別獎 89996565')).toBe(true);
});
it('parses ROC dates and checks the ten-day boundary', () => {
  const date = parseRocDate('資料日期：115年10月19日');
  expect(date?.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  expect(parseRocDate('資料日期：115年02月30日')).toBeNull();
  expect(isStale(date!, new Date('2026-10-29T00:00:00Z'))).toBe(false);
  expect(isStale(date!, new Date('2026-10-30T00:00:00Z'))).toBe(true);
});
it('reports a failed mocked call in the summary', async () => {
  const lines: string[] = [];
  const result = await runChecks([{ id: 'invoice-005', question: '測試', expected_tool: 'invoice_check', expected_args: {}, expected_key_facts: ['沒中'], daily_ci: true }], async () => ({ text: '沒有資料' }), line => lines.push(line));
  expect(result.failures).toEqual(['invoice-005']);
  expect(result.summary).toContain('失敗 1 題（invoice-005）');
  expect(lines.some(line => line.includes('回覆：沒有資料'))).toBe(true);
});
it.each([0, 30, 31])('warns only within 30 days of expiry (%i days remaining), and still calls the tool', async days => {
  const today = new Date('2026-10-29T00:00:00Z'), expires = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
  const log = vi.fn(), call = vi.fn(async () => ({ text: '沒中' }));
  const result = await runChecks([{ id: 'invoice-005', question: '測試', expected_tool: 'invoice_check', expected_args: {}, expected_key_facts: ['沒中'], daily_ci: true, expires }], call, log, today);
  expect(result.failures).toEqual([]);
  expect(call).toHaveBeenCalledOnce();
  const warnings = log.mock.calls.map(([line]) => line).filter(line => line.startsWith('警告：'));
  expect(warnings).toEqual(days <= 30 ? [`警告：題目 invoice-005 將於 ${expires} 過期，請準備更新`] : []);
});
it('fails expired daily questions without calling the tool and ignores non-daily expirations', async () => {
  const question = { id: 'invoice-005', question: '測試', expected_tool: 'invoice_check', expected_args: {}, expected_key_facts: ['沒中'], daily_ci: true, expires: '2026-10-28' };
  const log = vi.fn(), call = vi.fn(async () => ({ text: '沒中' }));
  const result = await runChecks([question, { ...question, id: 'invoice-008', daily_ci: false }], call, log, new Date('2026-10-29T00:00:00Z'));
  expect(result.failures).toEqual(['invoice-005']);
  expect(call).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('❌ invoice-005 測試：題目已過期（expires 2026-10-28），請更新題目');
});
it('aborts the call when the timeout expires', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const result = runChecks([{ id: 'invoice-005', question: '測試', expected_tool: 'invoice_check', expected_args: {}, expected_key_facts: ['沒中'], daily_ci: true }], async (_q, s) => { signal = s; return new Promise(() => {}); }, () => {});
    await vi.advanceTimersByTimeAsync(30000);
    expect(signal!.aborted).toBe(true);
    expect((await result).failures).toEqual(['invoice-005']);
  } finally { vi.useRealTimers(); }
});
