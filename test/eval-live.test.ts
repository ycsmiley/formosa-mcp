import { expect, it } from 'vitest';
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
