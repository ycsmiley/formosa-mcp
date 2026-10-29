# formosa-mcp

讓 Claude、Cursor 等 AI 助手查台灣發票對獎與台股盤後行情；高鐵／台鐵工具開發中。

<!-- 示範動畫：網址公開後錄製 -->
示範動畫即將推出。

## 開始使用

- Claude 連接器：公開網址：即將公開。之後在 Claude 的自訂連接器貼上網址即可。
- Cursor 一鍵安裝：即將推出。

開發者現在就能用，請看[開發者](#開發者)。

## 可以問什麼

- 「115 年 7–8 月發票 54348835 有沒有中？」
- 「這期發票特別獎幾號？」
- 「台積電收盤多少？」
- 「上櫃環球晶 6488 本益比多少？」
- 「台積電什麼時候除息？」

## 功能

- 發票：可用，查中獎號碼、領獎期間與對獎。
- 台股：可用，涵蓋上市＋上櫃；盤後資料，非即時，行情顯示資料日期。
- 高鐵／台鐵：開發中，須自備 TDX 金鑰並自行啟用。
- 氣象：之後推出（公開網址上線後的第二波）。

工具：

- `invoice_get_winning_numbers {period?}`：查最新或指定期別號碼、領獎期間；未公布期別顯示「尚未開獎」。
- `invoice_check {number, period?}`：接受 3–8 碼及兩碼英文字母前綴，3–7 碼只能判斷六獎；省略期別時檢查最新一期與仍可領獎的前一期。
- `stock_quote {query}`：以代號或名稱查上市／上櫃收盤、漲跌、成交量、本益比、殖利率與股價淨值比；名稱有多筆符合時列出代號供選擇。
- `stock_dividends {query?}`：列出近期除權息，預設前 20 筆；可指定股票代號或名稱。
- `thsr_timetable {origin, destination, date?, time?}`：高鐵起迄站時刻。
- `tra_timetable {origin, destination, date?, time?}`：台鐵時刻、車種、停駛與加班車。
- `tra_live {train_no?, station?}`：恰填一項，查車次目前位置／誤點或車站即時看板。

行情資料日期遇假日可能落後；除權息以公司公告為準。

## 開發者

[![每日即時檢查](https://github.com/ycsmiley/formosa-mcp/actions/workflows/daily-eval.yml/badge.svg)](https://github.com/ycsmiley/formosa-mcp/actions/workflows/daily-eval.yml)

需要 Node.js 20 以上。直接用 npm 套件：

```sh
npx -y formosa-mcp --toolsets=invoice,stock
```

MCP 客戶端設定：

```json
{
  "mcpServers": {
    "formosa": { "command": "npx", "args": ["-y", "formosa-mcp"] }
  }
}
```

從原始碼執行（需要 repository 存取權限）：

```sh
git clone https://github.com/ycsmiley/formosa-mcp.git
cd formosa-mcp
npm ci && npm run build
node dist/stdio.js --toolsets=invoice,stock
```

從原始碼執行時的 `mcpServers` 設定，請將路徑換成實際絕對路徑：

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

已提交的 bundle 不需安裝 npm 套件即可執行：`node plugin/server/formosa-mcp.mjs`；Claude Code plugin 使用的也是這個 bundle。安裝 plugin：

```sh
claude plugin marketplace add ycsmiley/formosa-mcp
claude plugin install formosa@formosa-mcp
```

`--toolsets=invoice,stock` 啟用發票與台股，也可只選一組；預設啟用這兩組，鐵路須明確啟用。`--help` 顯示用法。

資料來源與快取：

- [財政部 RSS](https://invoice.etax.nat.gov.tw/invoice.xml)：免金鑰，最近 6 期，快取 6 小時；單數月 25 日若新期尚未公布，改為 10 分鐘。依已公布資料回答。
- [證交所 OpenAPI](https://openapi.twse.com.tw/)及[櫃買中心 OpenAPI](https://www.tpex.org.tw/openapi/)：免金鑰，各資料集快取 1 小時，兩個股票工具共用；單一市場無法連線時仍回覆另一市場並附註。

驗證：執行 `npm run build`、`npm test`、`npm run live-check` 及 `npm run eval:live`。後兩者需要網路；每日即時評估詳見 [evals/README.md](evals/README.md)。

### 鐵路金鑰

至 [TDX 註冊](https://tdx.transportdata.tw/register)，審核後在會員中心取得 Client ID／Secret，設定 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET` 並重新啟動。以 `--toolsets=invoice,stock,rail` 或 `--toolsets=rail` 啟用；缺金鑰時呼叫會顯示設定指引。

使用自己的金鑰在本機執行，可查即時車次與誤點；未來公開網址只提供快取的時刻表與站點。尚未使用真實 TDX 金鑰驗證。成功回覆標示資料介接「交通部TDX平臺」；詳見 [TDX 鐵路測試資料](test/fixtures/tdx/README.md)。

### 遠端版（Cloudflare Workers）

Worker 請求只讀取 KV 快照，不會連線上游；證交所與發票由 Worker cron 更新，上櫃快照由 [GitHub Actions](.github/workflows/tpex-collect.yml) 寫入，因櫃買中心阻擋 Cloudflare。每 IP 每分鐘限制 30 次請求。

本機開發需 Node.js 22 以上；以下兩個 `kv key put --local` 指令將上櫃快照只寫入本機 KV，不會動到正式環境。

```sh
npm run dev:worker
# 另一個終端
npm run collect:tpex -- --out /tmp/tpex
npx wrangler kv key put --binding SNAPSHOTS --local "stock:quotes:tpex:v1" --path /tmp/tpex/stock_quotes_tpex_v1.json
npx wrangler kv key put --binding SNAPSHOTS --local "stock:dividends:tpex:v1" --path /tmp/tpex/stock_dividends_tpex_v1.json
curl "http://localhost:8787/__scheduled"
npm run remote-check
```

驗證可執行 `npm run typecheck:worker`、`npm run test:worker`。`@modelcontextprotocol/sdk` 為配合 `agents` 固定於精確版本 `1.32.1`。

## English

Let AI assistants such as Claude and Cursor check Taiwan invoice prizes and end-of-day stock prices. HSR and TRA tools are in development.

Demo animation coming soon.

### Get started

- Claude connector: Public URL: coming soon. Once available, paste it into a custom connector in Claude.
- Cursor one-click install: coming soon.

Developers can use it now; see [Developers](#developers).

### What can I ask?

- “Did invoice 54348835 win in the July–August 2026 draw (ROC 115)?”
- “What is this period's special prize number?”
- “What was TSMC's closing price?”
- “What is the P/E ratio for OTC stock GlobalWafers 6488?”
- “When is TSMC's ex-dividend date?”

### Features

Invoices cover winning numbers, claim periods and number checks. Stocks cover TWSE and TPEx end-of-day data, not real-time; quotes show the data date. HSR / TRA are in development and require your own TDX key. Weather: later, in a second wave after the public URL launches.

The tools are `invoice_get_winning_numbers`, `invoice_check`, `stock_quote`, `stock_dividends`, `thsr_timetable`, `tra_timetable` and `tra_live`; their arguments and details are listed [above](#功能).

### Developers

[![Daily live check](https://github.com/ycsmiley/formosa-mcp/actions/workflows/daily-eval.yml/badge.svg)](https://github.com/ycsmiley/formosa-mcp/actions/workflows/daily-eval.yml)

Node.js 20+ is required. Run the npm package directly:

```sh
npx -y formosa-mcp --toolsets=invoice,stock
```

MCP client configuration:

```json
{
  "mcpServers": {
    "formosa": { "command": "npx", "args": ["-y", "formosa-mcp"] }
  }
}
```

From source (repository access required):

```sh
git clone https://github.com/ycsmiley/formosa-mcp.git
cd formosa-mcp
npm ci && npm run build
node dist/stdio.js --toolsets=invoice,stock
```

From-source configuration (replace the path with your absolute path):

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

The committed bundle also runs without installing npm packages via `node plugin/server/formosa-mcp.mjs`. Install the Claude Code plugin with `claude plugin marketplace add ycsmiley/formosa-mcp`, then `claude plugin install formosa@formosa-mcp`.

Invoice and stock toolsets are enabled by default; use `--toolsets` to select them or opt into rail, and `--help` for usage. MOF invoice RSS caches for six hours (ten minutes on announcement day when the new draw is pending); TWSE and TPEx stock datasets cache for one hour. Run `npm run build`, `npm test`, `npm run live-check` and `npm run eval:live`; the latter two need network access. See [live evaluations](evals/README.md).

Register with [TDX](https://tdx.transportdata.tw/register), set your own `TDX_CLIENT_ID` and `TDX_CLIENT_SECRET`, and enable `rail` to use rail tools locally, including live train delays. The future public URL will serve cached timetables and stations only. Rail has not yet been verified with a real TDX key. Successful replies credit 資料介接「交通部TDX平臺」; see [TDX fixtures](test/fixtures/tdx/README.md).

### Remote (Cloudflare Workers)

Requests read KV snapshots only, never upstream. Worker cron refreshes TWSE and invoices; [GitHub Actions](.github/workflows/tpex-collect.yml) writes TPEx snapshots because TPEx blocks Cloudflare. The limit is 30 requests per IP per minute.

Local development needs Node.js 22+; the two `kv key put --local` commands write TPEx snapshots only to local KV, leaving production untouched.

```sh
npm run dev:worker
# another terminal
npm run collect:tpex -- --out /tmp/tpex
npx wrangler kv key put --binding SNAPSHOTS --local "stock:quotes:tpex:v1" --path /tmp/tpex/stock_quotes_tpex_v1.json
npx wrangler kv key put --binding SNAPSHOTS --local "stock:dividends:tpex:v1" --path /tmp/tpex/stock_dividends_tpex_v1.json
curl "http://localhost:8787/__scheduled"
npm run remote-check
```

Verify with `npm run typecheck:worker` and `npm run test:worker`. `@modelcontextprotocol/sdk` is pinned exactly to `1.32.1` for `agents`.

## License

MIT
