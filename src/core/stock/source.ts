// Plain GET, no key/headers. Feeds are arrays of string-valued objects.
export const stockUrls = {
  'twse-quotes': 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  'twse-ratios': 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  'twse-div': 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL',
  'tpex-quotes': 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
  'tpex-ratios': 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
  'tpex-div': 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
} as const;
// TWSE: Date/Code/Name, OpeningPrice/HighestPrice/LowestPrice/ClosingPrice,
// Change (gains lack +), TradeVolume (shares), TradeValue (NT$), PEratio/DividendYield/PBratio.
// TPEx: Date/SecuritiesCompanyCode/CompanyName, Open/High/Low/Close/Change,
// TradingShares/TransactionAmount, PriceEarningRatio/YieldRatio/PriceBookRatio.
// TPEx Change is signed, 除息, or ---; no-trade prices are ----. Keep trimming stray spaces.
// TPEx TradingShares/TransactionAmount cover regular round lots only; TWSE STOCK_DAY_ALL includes odd lots.
// Dates are ROC 1151022, end-of-day and may lag holidays: always display the feed date.
// Missing: empty, --, ---, ----, N/A, 尚未公告; strip spaces/commas from numbers.
// Dividends: TWSE Date/Exdividend (息/權/權息); TPEx ExRrightsExDividendDate/
// ExRrightsExDividend (API typo). Both: CashDividend/StockDividendRatio/SubscriptionPricePerShare;
// subscription ratio: TWSE SubscriptionRatio, TPEx SubscriptionRatioToNewSharesIssued.
// Schedules include past dates; blank cash means unannounced (often ETFs).
// 權 may mean cash capital increase; subscription price can be 尚未公告.
export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export const marketUrls = {
  fmtqik: 'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',
  margn: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',
  tpexIndex: 'https://www.tpex.org.tw/openapi/v1/tpex_daily_trading_index',
  tpexMargin: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance',
} as const;
export interface MarketFeed { body: unknown; lastModified?: string }
export async function fetchMarketFeed(url: string): Promise<MarketFeed> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { body: await response.json(), lastModified: response.headers.get('Last-Modified') ?? undefined };
  } catch { throw new Error(`無法取得${url.includes('twse.com.tw') ? '證交所' : '櫃買中心'} OpenAPI：${url}`); }
}
