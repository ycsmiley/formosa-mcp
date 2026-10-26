import { TtlCache } from '../cache.js';
import { taipeiParts, type Clock } from '../clock.js';
import { fetchInvoiceFeed } from './source.js';
import { comparePeriods, expectedDrawDate, isClaimable, latestExpectedDrawnPeriod, normalizePeriod, parseInvoiceFeed, periodLabel, previousPeriod, type Draw, type Period } from './parse.js';
import { checkNumber } from './match.js';
import { formatCheckResult, formatWinningNumbers } from './format.js';
export interface InvoiceResult { text: string; isError: boolean }
export interface InvoiceCache {
  getOrLoad(key: string, loader: () => Promise<Draw[]>): Promise<Draw[]>;
}
export interface InvoiceServiceOptions {
  loadDraws?: () => Promise<Draw[] | null>;
  fetchFeed?: () => Promise<string>;
  clock?: Clock;
  cache?: InvoiceCache;
}
const text = (text: string, isError = false): InvoiceResult => ({ text, isError });
export function createInvoiceService({ loadDraws, fetchFeed = fetchInvoiceFeed, clock = () => new Date(), cache: injectedCache }: InvoiceServiceOptions = {}) {
  const cache = injectedCache ?? new TtlCache<Draw[]>(draws => {
    const { month, day } = taipeiParts(clock());
    return day === 25 && month % 2 === 1 && comparePeriods(draws[0].period, latestExpectedDrawnPeriod(clock)) < 0
      ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
  }, () => clock().getTime());
  const load = () => loadDraws ? loadDraws() : cache.getOrLoad('invoice', async () => parseInvoiceFeed(await fetchFeed()));
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
    catch (error) { if (loadDraws) return text('暫時無法取得資料，請稍後再試。', true); return text(`目前連不到財政部資料來源，請稍後再試（錯誤：${error instanceof Error ? error.message : String(error)}）`, true); }
  };
  return {
    async getWinningNumbers(period?: string): Promise<InvoiceResult> {
      const p = period === undefined ? undefined : normalizePeriod(period);
      if (p === null) return text(invalidPeriod, true);
      return safely(async () => {
        const draws = await load();
        if (!draws?.length) return text('資料更新中，請稍後再試', true);
        const draw = p ? draws.find(d => comparePeriods(d.period, p) === 0) : draws[0];
        return draw ? text(formatWinningNumbers(draw, clock)) : text(missing(p!, draws));
      });
    },
    async check(number: string, period?: string): Promise<InvoiceResult> {
      const p = period === undefined ? undefined : normalizePeriod(period);
      if (p === null) return text(invalidPeriod, true);
      // Validate before fetching so an invalid number remains useful offline.
      const validation = checkNumber(number, { period: { rocYear: 1, evenMonth: 2 }, special: '', grand: '', first: [], extraSixth: [] });
      if (!validation.ok) return text(validation.error, true);
      return safely(async () => {
        const draws = await load();
        if (!draws?.length) return text('資料更新中，請稍後再試', true);
        const formatResults = (selected: Draw[]) => [
          ...selected.map(d => formatCheckResult(d, checkNumber(number, d), clock)),
          ...(validation.partial ? ['只能判斷六獎，大獎要對完整 8 碼。'] : []),
        ].join('\n\n');
        if (p) {
          const draw = draws.find(d => comparePeriods(d.period, p) === 0);
          return draw ? text(formatResults([draw])) : text(missing(p, draws));
        }
        const selected = [draws[0]];
        const previous = draws.find(d => comparePeriods(d.period, previousPeriod(draws[0].period)) === 0);
        if (previous && isClaimable(previous.period, clock)) selected.push(previous);
        return text(formatResults(selected));
      });
    },
  };
}
