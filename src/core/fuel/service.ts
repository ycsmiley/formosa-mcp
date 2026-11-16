import { TtlCache } from '../cache.js';
import type { Clock } from '../clock.js';
import { formatFuel } from './format.js';
import { parseFuel } from './parse.js';
import { fetchFuel, fuelFailureSource, fuelNotice, fuelReason } from './source.js';
import type { FuelSnapshot } from './model.js';
export interface FuelStore { read(): Promise<FuelSnapshot | null> }
export function createFuelService(options: { fuelStore?: FuelStore; fetchFuel?: () => Promise<unknown>; clock?: Clock } = {}) {
  const clock = options.clock ?? (() => new Date()), cache = new TtlCache<FuelSnapshot>(3600000, () => clock().getTime());
  return { async query(product?: string) {
    try {
      const snapshot = options.fuelStore ? await options.fuelStore.read() : await cache.getOrLoad('cpc', async () => {
        const items = parseFuel(await (options.fetchFuel ?? fetchFuel)()), time = clock().toISOString();
        return { v: 1, items, changedAt: time, checkedAt: time };
      });
      if (!snapshot) return { isError: true, text: `中油牌價資料尚未準備好，請稍後再試。${fuelFailureSource}\n${fuelNotice}` };
      return { text: formatFuel(snapshot, product, clock()) };
    } catch (e) {
      return { isError: true, text: `${options.fuelStore ? '中油牌價資料尚未準備好，請稍後再試。' : `無法取得中油牌價（${fuelReason(e)}），請稍後再試。`}${fuelFailureSource}\n${fuelNotice}` };
    }
  } };
}
