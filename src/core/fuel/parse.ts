import { validDay, validItems, type FuelItem } from './model.js';
export function parseFuel(body: unknown): FuelItem[] {
  const invalid = () => new Error('中油牌價資料格式不正確或汽柴油零售筆數不足');
  if (!Array.isArray(body)) throw invalid();
  const items = body.map(row => {
    if (!row || typeof row !== 'object') throw invalid();
    const text = (key: string) => typeof row[key] === 'string' ? row[key].trim() : '';
    const roc = text('牌價生效日期');
    if (!/^\d{7}$/.test(roc) || Number(roc.slice(0, 3)) === 0) throw invalid();
    const effective = `${Number(roc.slice(0, 3)) + 1911}-${roc.slice(3, 5)}-${roc.slice(5, 7)}`;
    if (!validDay(effective)) throw invalid();
    return { category: text('型別名稱'), product: text('產品名稱'), customer: text('銷售對象'), place: text('交貨地點'), unit: text('計價單位').replace(/\s*\/\s*/g, '/'), price: row['參考牌價_金額'], effective };
  });
  if (!validItems(items)) throw invalid();
  return items;
}
