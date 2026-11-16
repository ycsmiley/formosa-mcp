import { fuelWarning } from '../freshness.js';
import { fuelSource, fuelNotice } from './source.js';
import type { FuelSnapshot } from './model.js';
const dateLabel = (day: string) => `${day}（星期${'日一二三四五六'[new Date(day).getUTCDay()]}）`;
export function formatFuel(s: FuelSnapshot, product: string | undefined, now: Date): string {
  const query = product?.trim(), items = s.items.filter(i => query ? i.product.includes(query) : i.category === '汽柴油零售' && i.place === '中油自營站');
  const lines: string[] = [];
  const sharedDate = new Set(items.map(i => i.effective)).size === 1;
  if (!items.length) lines.push(`找不到「${query}」的中油牌價。可查詢產品：${[...new Set(s.items.map(i => i.product))].join('、')}。`);
  let group = '';
  for (const i of items) {
    const next = `${i.category}，${i.customer}，${i.place}`;
    if (group !== next) { lines.push(`台灣中油牌價（${next}）`); group = next; }
    lines.push(`${i.product}：${i.price} ${i.unit}${sharedDate ? '' : `｜牌價生效日：${dateLabel(i.effective)}`}`);
  }
  if (sharedDate) lines.push(`牌價生效日：${dateLabel(items[0].effective)}`);
  if (!query) lines.push('另有海運柴油、燃料油等牌價，可用 product 參數查詢（例如「燃料油」）。');
  const checked = new Date(Date.parse(s.checkedAt) + 8 * 3600000).toISOString();
  lines.push(`資料時間：${checked.slice(0, 10)} ${checked.slice(11, 16)}（臺北時間，最後確認）`);
  const warning = fuelWarning(s.checkedAt, now);
  return [...lines, ...(warning ? [warning] : []), fuelSource, fuelNotice].join('\n');
}
