// Ministry of Finance RSS: https://invoice.etax.nat.gov.tw/invoice.xml
// Sample fetched 2026-10-26:
// <item>
//   <title><![CDATA[115年 07~08月]]></title>
//   <link><![CDATA[https://www.etax.nat.gov.tw/etw-main/ETW183W2_11507]]></link>
//   <pubDate>Fri, 25 Sep 2026 05:00:33 GMT</pubDate>
//   <description><![CDATA[<p>特別獎：89996565</p><p>特獎：91098182</p><p>頭獎：54348835、44991397、06595111</p>]]></description>
// </item>
export async function fetchInvoiceFeed(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl('https://invoice.etax.nat.gov.tw/invoice.xml', {
    signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'formosa-mcp' },
  });
  if (response.status !== 200) throw new Error(`財政部資料來源回應 HTTP ${response.status}`);
  return response.text();
}
