export const fuelKey = 'fuel:cpc:v1';
export interface FuelItem { category: string; product: string; customer: string; place: string; unit: string; price: number; effective: string }
export interface FuelSnapshot { v: 1; items: FuelItem[]; changedAt: string; checkedAt: string }
export const validDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
export const validTime = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && validDay(s.slice(0, 10)) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().replace('.000Z', 'Z') === s.replace('.000Z', 'Z');
const fields = ['category', 'product', 'customer', 'place', 'unit'];
export function validItems(items: unknown): items is FuelItem[] {
  return Array.isArray(items) && items.every(i => i && typeof i === 'object' && Object.keys(i).sort().join() === [...fields, 'price', 'effective'].sort().join() && fields.every(k => typeof i[k] === 'string' && i[k].trim() === i[k] && i[k].length > 0) && typeof i.price === 'number' && Number.isFinite(i.price) && i.price > 0 && validDay(i.effective)) && items.filter(i => i.category === '汽柴油零售').length >= 4;
}
export function decodeFuel(raw: unknown): FuelSnapshot | null {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return s && Object.keys(s).sort().join() === 'changedAt,checkedAt,items,v' && s.v === 1 && validItems(s.items) && validTime(s.changedAt) && validTime(s.checkedAt) ? s : null;
  } catch { return null; }
}
