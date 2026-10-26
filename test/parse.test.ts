import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { normalizePeriod, parseInvoiceFeed, periodCode, periodLabel, previousPeriod, comparePeriods } from '../src/toolsets/invoice/parse.js';
const xml = readFileSync(new URL('./fixtures/invoice.xml', import.meta.url), 'utf8');
describe('period normalization', () => {
  it.each(['11510', '11509', '115-09', '115-10', '115/9', '115年9-10月', '115年09～10月', '115年 09~10月', '115年10月', '2026-09', '2026-10'])('%s', input => {
    expect(normalizePeriod(input)).toEqual({ rocYear: 115, evenMonth: 10 });
  });
  it.each(['', 'garbage', '11500', '11513', '115年10-11月', '115年9-12月', '1911-09', '00009'])('rejects %s', input => expect(normalizePeriod(input)).toBeNull());
  it('uses even month for canonical code and label', () => {
    const p = normalizePeriod('11409')!;
    expect(periodCode(p)).toBe('11410');
    expect(periodLabel(p)).toBe('114年09-10月');
    expect(previousPeriod({ rocYear: 115, evenMonth: 2 })).toEqual({ rocYear: 114, evenMonth: 12 });
    expect(comparePeriods(p, previousPeriod(p))).toBeGreaterThan(0);
  });
});
describe('RSS parsing', () => {
  it('parses six real draws newest first and preserves leading zeros', () => {
    const draws = parseInvoiceFeed(xml);
    expect(draws).toHaveLength(6);
    expect(periodCode(draws[0].period)).toBe('11508');
    expect(draws[0]).toMatchObject({ special: '89996565', grand: '91098182', first: ['54348835', '44991397', '06595111'], extraSixth: [] });
    expect(draws[4].grand).toBe('00507588');
    expect(draws[0].sourceUrl).toContain('ETW183W2_11507');
    expect(draws[0].pubDate).toContain('25 Sep 2026');
  });
  it('parses extra sixth prizes', () => expect(parseInvoiceFeed(xml.replace('<p>特別獎', '<p>增開六獎：123、456</p><p>特別獎'))[0].extraSixth).toEqual(['123', '456']));
  it('skips malformed items', () => expect(parseInvoiceFeed(xml.replace('</channel>', '<item><title>11510</title></item></channel>'))).toHaveLength(6));
  it.each(['', '<rss/>', '<item><title>garbage</title></item>'])('throws for zero parsed draws %s', input => expect(() => parseInvoiceFeed(input)).toThrow('沒有可解析'));
});
