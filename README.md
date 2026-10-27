# formosa-mcp

讓 Claude、Cursor、OpenClaw 等主流 agent 都懂台灣：貼一個網址就能用，查得到高鐵、台鐵、台股、發票。

<!-- TODO: 30 秒示範 GIF -->
（示範 GIF 製作中）

**公開網址版即將推出**

## 功能

- 發票（可用）：中獎號碼、領獎期間與發票對獎。
- 台股（可用）：上市＋上櫃，盤後資料非即時。
- 高鐵／台鐵（開發中）。

工具：

- `invoice_get_winning_numbers {period?}`：查最新或指定期別號碼、領獎期間；未公布期別顯示「尚未開獎」。
- `invoice_check {number, period?}`：接受 3–8 碼及兩碼英文字母前綴，3–7 碼只能判斷六獎；省略期別時檢查最新一期與仍可領獎的前一期。
- `stock_quote {query}`：以代號或名稱查上市／上櫃收盤、漲跌、成交量、本益比、殖利率與股價淨值比；名稱有多筆符合時列出代號供選擇。
- `stock_dividends {query?}`：列出近期除權息，預設前 20 筆；可指定股票代號或名稱。

台股：盤後資料，非即時（證交所／櫃買中心 OpenAPI，免金鑰，1 小時快取）。行情顯示來源自己的資料日期，遇假日可能落後；除權息以公司公告為準。

## 開發者

需要 Node.js 20 以上。提供 stdio；src/core 核心函式庫獨立於 MCP。Worker 開發工具需要 Node.js 22 以上。

Claude Code：`claude plugin marketplace add ycsmiley/formosa-mcp`，再執行 `claude plugin install formosa@formosa-mcp`；修改 server 後以 `npm run build:plugin` 更新 bundle。（格式參考 [Agent Skills](https://agentskills.io/specification) 與 [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)。）

### 鐵路工具（需自行提供 TDX 金鑰）

- `thsr_timetable {origin, destination, date?, time?}`：高鐵起迄站時刻。
- `tra_timetable {origin, destination, date?, time?}`：臺鐵 v3 時刻、車種、停駛與加班車。
- `tra_live {train_no?, station?}`：恰填一項，查車次目前位置／誤點或車站即時看板。

至 [TDX 註冊](https://tdx.transportdata.tw/register) 成為會員（審核後），在會員中心 → API金鑰取得 Client Id／Secret，設定環境變數 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET` 並重新啟動。以 `node dist/stdio.js --toolsets rail` 或 `--toolsets invoice,stock,rail` 啟用；缺金鑰時仍列出工具，呼叫會顯示設定指引。全部啟用共 7 個工具。Worker 與 plugin 預設設定仍僅提供 invoice、stock。

每個成功回覆標示：資料介接「交通部TDX平臺」。

詳見 [TDX 鐵路測試資料](test/fixtures/tdx/README.md)。

尚未使用真實 TDX 金鑰驗證。

### 本機跑遠端版（Cloudflare Workers）

目前僅供本機測試，沒有公開 URL，也不需要 Cloudflare 登入。

`@modelcontextprotocol/sdk` 固定為精確版本 `1.32.1`，因為 `agents` 的 `createMcpHandler` 對此版本有精確的 peer 相依要求，請勿單獨升級。

```sh
npm run dev:worker
# 另一個終端：排程抓上游並填入本機 KV
curl "http://localhost:8787/__scheduled"
npm run remote-check
# 額外驗證每 IP 每分鐘 30 次限流
npm run remote-check -- --burst
```

請求只讀 KV；尚未填入時回覆「資料更新中」。行情與除權息各按市場儲存於 `stock:quotes:{twse,tpex}:v1`、`stock:dividends:{twse,tpex}:v1`，讀取時合併；排程保留失敗項目的前次資料，資料未變不寫入 KV，metadata 的 `updatedAt` 表示最後資料變更時間。
UTC 週一至五整點／半點更新上市、15／45 分更新上櫃；UTC 週末每 6 小時的整點更新上市、半點更新上櫃。發票維持每 3 小時更新，單數月 25 日台北 13:00–23:50 加密為每 10 分鐘；共 5 個 cron。
股票排程以 `stock:meta:{twse,tpex}:v1` 保存 ETag／Last-Modified；兩份 snapshot 都存在且三個來源皆回覆 304 時，略過解析與所有 KV 寫入。任一來源更新便補抓其他來源，所有來源皆為 200 且兩份 snapshot 都成功或未變才更新 meta；否則若原有 meta，便刪除它，讓下次無條件重抓。上市行情少於 100 筆、上櫃少於 50 筆或發票無期別時保留舊值。每日最壞寫入量：平日兩市場各 48 次 × 每次最多 3 筆（行情、除權息、meta；刪除也算一次寫入，包含在這 3 筆內），加發票 8 + 66 次 = **362 次**；週末最多 2 × 4 × 3 + 74 = 98 次，均低於免費方案的每日 1,000 次（假設每次資料與驗證資訊皆改變）。
`wrangler.jsonc` 的 namespace ID 是佔位值，任何未來部署前都必須替換；目前不部署。
執行 `npm run typecheck:worker`、`npm run test:worker` 驗證 Worker；stdio 建置不包含 Worker。

發布到 npm 後可用：

```sh
npx -y formosa-mcp --toolsets=invoice,stock
```

本機執行：

```sh
npm install && npm run build && node dist/stdio.js --toolsets=invoice,stock
```

Claude Desktop / Cursor 的 `mcpServers` 設定（發布到 npm 後可用）：

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp", "--toolsets=invoice,stock"]
    }
  }
}
```

本機版本：先完成建置，將路徑換成實際的絕對路徑。

```json
{
  "mcpServers": {
    "formosa": {
      "command": "node",
      "args": ["/absolute/path/formosa-mcp/dist/stdio.js", "--toolsets=invoice,stock"]
    }
  }
}
```

使用 `--toolsets=invoice,stock` 啟用兩組工具；也可只指定 `invoice` 或 `stock`。未指定時固定啟用 invoice、stock，共 4 個工具；rail 必須明確啟用。`--help` 顯示用法。

資料來源與快取：

- [財政部 RSS](https://invoice.etax.nat.gov.tw/invoice.xml)：免金鑰，只含最近 6 期，6 小時快取；單數月 25 日若新期尚未公布，改為 10 分鐘快取。實際查詢依已公布資料回答。
- [臺灣證券交易所 OpenAPI](https://openapi.twse.com.tw/) 與 [證券櫃檯買賣中心 OpenAPI](https://www.tpex.org.tw/openapi/)：行情、估值與除權息，免金鑰，各資料集快取 1 小時，兩個工具共用。單一市場無法連線時仍回覆另一市場並附註。

驗證：

```sh
npm run build
npm test
npm run live-check
```

`live-check` 會建置並透過 MCP SDK 啟動實際 server，連線財政部、證交所與櫃買中心驗證工具，需要網路。
評估題目與欄位說明見 [evals/README.md](evals/README.md)，目前沒有評估 runner。

## English

Help mainstream agents such as Claude, Cursor, and OpenClaw understand Taiwan: connect with a URL to look up HSR, TRA, Taiwan stocks, and invoices.

<!-- TODO: 30-second demo GIF -->
(Demo GIF in production.)

**Public remote URL coming soon**

### Features

- Invoices (available): winning numbers, claim periods, and lottery checking.
- Taiwan stocks (available): TWSE listed and TPEx OTC stocks, end-of-day data, not real-time.
- HSR / TRA (in development).

Tools:

- `invoice_get_winning_numbers {period?}`: latest or specified draw and claim period; unpublished draws are identified.
- `invoice_check {number, period?}`: accepts 3–8 digits and optional two-letter prefixes. Partial numbers only check sixth prizes. Without a period, checks the latest draw and the previous draw if still claimable.
- `stock_quote {query}`: find TWSE/TPEx quotes by code or name, including prices, change, volume, PE, dividend yield, and PB. Ambiguous names return a selection list.
- `stock_dividends {query?}`: upcoming ex-dividend and ex-right schedule, first 20 events by default, optionally filtered by code or name.

Stock data is end-of-day, not real-time (TWSE/TPEx OpenAPI, no API key, one-hour cache). Quotes show the source date, which can lag on holidays. Company announcements take precedence for dividends.

### Developers

Requires Node.js 20 or later. The MCP-independent core in src/core supports stdio. Worker development tools require Node.js 22 or later.

### Rail (opt-in; your own TDX credentials)

- `thsr_timetable {origin, destination, date?, time?}`
- `tra_timetable {origin, destination, date?, time?}`
- `tra_live {train_no?, station?}` (exactly one argument)

[Register with TDX](https://tdx.transportdata.tw/register), obtain an API key from the member center, and set `TDX_CLIENT_ID` and `TDX_CLIENT_SECRET`. Enable with `--toolsets rail` or `--toolsets invoice,stock,rail`. Defaults remain invoice and stock; Worker and plugin exclude rail.

Successful rail replies end with 資料介接「交通部TDX平臺」. See the [TDX rail fixtures](test/fixtures/tdx/README.md).

Not yet verified with a real TDX key.

### Local Cloudflare Workers remote

Local-only for now; no public URL exists and no Cloudflare login is needed. With Node.js 22+, run `npm run dev:worker`, then `curl "http://localhost:8787/__scheduled"` to fill local KV and `npm run remote-check` (add `-- --burst` to check rate limiting). Requests only read snapshots; scheduled refreshes fetch upstream. The KV ID is a deployment placeholder. Use `npm run typecheck:worker` and `npm run test:worker`; the stdio build excludes Worker code.

After publication to npm:

```sh
npx -y formosa-mcp --toolsets=invoice,stock
```

Run locally:

```sh
npm install && npm run build && node dist/stdio.js --toolsets=invoice,stock
```

MCP client configuration after npm publication:

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp", "--toolsets=invoice,stock"]
    }
  }
}
```

For local use, build first and replace the path with your absolute path:

```json
{
  "mcpServers": {
    "formosa": {
      "command": "node",
      "args": ["/absolute/path/formosa-mcp/dist/stdio.js", "--toolsets=invoice,stock"]
    }
  }
}
```

Select toolsets with `--toolsets=invoice,stock`, or choose either one. The default enables invoice and stock, four tools total; rail requires explicit opt-in. Use `--help` for usage.

Sources and caching:

- [Ministry of Finance RSS](https://invoice.etax.nat.gov.tw/invoice.xml): no key, latest six draws, six-hour cache. On announcement days, an unpublished new draw reduces the cache to ten minutes.
- [TWSE OpenAPI](https://openapi.twse.com.tw/) and [TPEx OpenAPI](https://www.tpex.org.tw/openapi/): no key, one-hour cache per dataset shared by both stock tools. If one market is unavailable, the other still returns results with a notice.

Run `npm run build`, `npm test`, and `npm run live-check`. The live check builds and starts the actual MCP server and needs network access to all three sources. See [evals/README.md](evals/README.md) for evaluation questions; no evaluation runner is included yet.

## License

MIT
