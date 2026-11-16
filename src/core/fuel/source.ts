export const fuelUrl = 'https://vipmbr.cpc.com.tw/opendata/mainprodlistprice';
export const fuelSource = `資料來源：台灣中油 openData 主要產品牌價 ${fuelUrl} （政府資料開放授權條款第1版）`;
export const fuelFailureSource = `資料來源：台灣中油 openData ${fuelUrl}`;
export const fuelNotice = '只有台灣中油牌價，不含台塑石化；各加油站實際售價可能不同。';
export async function fetchFuel(): Promise<unknown> {
  const r = await fetch(fuelUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}
// Local failures use a small allowlist; upstream error text can contain credentials.
export function fuelReason(e: unknown): string {
  if (e instanceof Error && /^HTTP \d{3}$/.test(e.message)) return e.message;
  if (e instanceof Error && /Timeout|Abort/.test(e.name)) return '連線逾時';
  return e instanceof Error && e.message.startsWith('中油牌價資料') ? '資料格式不正確' : '來源暫時無法使用';
}
