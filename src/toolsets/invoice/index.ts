import { z } from 'zod';
import { TtlCache } from '../../lib/cache.js';
import { taipeiParts, type Clock } from '../../lib/clock.js';
import type { Toolset } from '../index.js';
import { fetchInvoiceFeed } from './source.js';
import { comparePeriods, expectedDrawDate, isClaimable, latestExpectedDrawnPeriod, normalizePeriod, parseInvoiceFeed, periodLabel, previousPeriod, type Draw, type Period } from './parse.js';
import { checkNumber } from './match.js';
import { formatCheckResult, formatWinningNumbers } from './format.js';
const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) });
export function createInvoiceToolset({ fetchFeed = fetchInvoiceFeed, clock = () => new Date() }: { fetchFeed?: () => Promise<string>; clock?: Clock } = {}): Toolset {
  const cache = new TtlCache<Draw[]>(draws => {
    const { month, day } = taipeiParts(clock());
    return day === 25 && month % 2 === 1 && comparePeriods(draws[0].period, latestExpectedDrawnPeriod(clock)) < 0
      ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
  }, () => clock().getTime());
  const load = () => cache.getOrLoad('invoice', async () => parseInvoiceFeed(await fetchFeed()));
  const missing = (p: Period, draws: Draw[]) => {
    if (comparePeriods(p, draws[0].period) > 0) {
      const date = expectedDrawDate(p);
      return `${periodLabel(p)}尚未開獎，預計 ${date.year - 1911}年${date.month}月25日開獎。`;
    }
    return `資料來源只提供最近 6 期，查不到 ${periodLabel(p)}。`;
  };
  const invalidPeriod = '期別格式不正確，請輸入例如 11509、115年9-10月或 2026-09。';
  const safely = async (action: () => Promise<ReturnType<typeof text>>) => {
    try { return await action(); }
    catch (error) { return text(`目前連不到財政部資料來源，請稍後再試（錯誤：${error instanceof Error ? error.message : String(error)}）`, true); }
  };
  return {
    name: 'invoice', description: '統一發票對獎 Taiwan uniform invoice lottery',
    register(server) {
      server.registerTool('invoice_get_winning_numbers', {
        description: '查詢統一發票中獎號碼與領獎期間。Get Taiwan invoice winning numbers; omit period for the latest draw.',
        inputSchema: { period: z.string().optional() },
      }, async ({ period }) => {
        const p = period === undefined ? undefined : normalizePeriod(period);
        if (p === null) return text(invalidPeriod, true);
        return safely(async () => {
          const draws = await load();
          const draw = p ? draws.find(d => comparePeriods(d.period, p) === 0) : draws[0];
          return draw ? text(formatWinningNumbers(draw, clock)) : text(missing(p!, draws));
        });
      });
      server.registerTool('invoice_check', {
        description: '統一發票對獎；未指定期別時檢查最新一期與仍可領獎的前一期。Check a Taiwan invoice number; 3–7 digits only check sixth prizes.',
        inputSchema: { number: z.string(), period: z.string().optional() },
      }, async ({ number, period }) => {
        const p = period === undefined ? undefined : normalizePeriod(period);
        if (p === null) return text(invalidPeriod, true);
        // Validate before fetching so an invalid number remains useful offline.
        const validation = checkNumber(number, { period: { rocYear: 1, evenMonth: 2 }, special: '', grand: '', first: [], extraSixth: [] });
        if (!validation.ok) return text(validation.error, true);
        return safely(async () => {
          const draws = await load();
          if (p) {
            const draw = draws.find(d => comparePeriods(d.period, p) === 0);
            return draw ? text(formatCheckResult(draw, checkNumber(number, draw), clock)) : text(missing(p, draws));
          }
          const selected = [draws[0]];
          const previous = draws.find(d => comparePeriods(d.period, previousPeriod(draws[0].period)) === 0);
          if (previous && isClaimable(previous.period, clock)) selected.push(previous);
          return text(selected.map(d => formatCheckResult(d, checkNumber(number, d), clock)).join('\n\n'));
        });
      });
    },
  };
}
export default createInvoiceToolset();
