# formosa-mcp

**繁體中文** · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/formosa-mcp)](https://www.npmjs.com/package/formosa-mcp) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![CI](https://github.com/ycsmiley/formosa-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ycsmiley/formosa-mcp/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/formosa-mcp)](package.json)

讓 Claude、Cursor 等 AI 助手查台灣統一發票對獎、台股（上市＋上櫃）盤後行情與五都垃圾車時刻，免金鑰；高鐵／台鐵遠端版提供今天與明天的時刻表。
Taiwan e-invoice lottery and TWSE/TPEx stock data for AI agents (MCP), no API key.

## 開始使用

需要 Node.js 20 以上。

在 Claude Desktop 的 `claude_desktop_config.json` 或 Cursor 的 `.cursor/mcp.json`（或 `~/.cursor/mcp.json`）加入以下設定，然後重新啟動應用程式：

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp"]
    }
  }
}
```

Claude Code：

```sh
claude mcp add formosa -- npx -y formosa-mcp
```

Claude Code plugin：

```sh
claude plugin marketplace add ycsmiley/formosa-mcp
claude plugin install formosa@formosa-mcp
```

發票與台股免金鑰；高鐵／台鐵見[鐵路說明](#遠端鐵路)。

免金鑰的公開網址即將推出，屆時貼到 Claude 的自訂連接器即可使用。

## 可以問什麼

- 「115 年 7–8 月發票 54348835 有沒有中？」
- 「這期發票特別獎幾號？」
- 「台積電收盤多少？」
- 「上櫃環球晶 6488 本益比多少？」
- 「台積電什麼時候除息？」
- 「板橋文化路垃圾車幾點來？」

## 功能

- 發票：可用，查中獎號碼、領獎期間與對獎。
- 台股：可用，涵蓋上市＋上櫃；盤後資料，非即時，行情顯示資料日期。
- 高鐵／台鐵：遠端版預設提供今天與明天的時刻表、額度內的臺鐵即時資料；本機版見[鐵路說明](#鐵路金鑰)。
- 垃圾車：查詢新北、臺北、臺中、臺南、高雄定點收運時刻；請提供行政區與里名、路名或地點。
- 氣象：規劃中。

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

從原始碼執行：

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

1. 到 [TDX](https://tdx.transportdata.tw) 註冊免費會員，等待審核。免費會員有每月呼叫次數上限。
2. 在會員中心 → API 金鑰取得 Client Id／Client Secret。
3. 在 Claude Desktop（`claude_desktop_config.json`）或 Cursor（`.cursor/mcp.json` 或 `~/.cursor/mcp.json`）的 MCP 設定加入 `env`，將下列佔位文字換成自己的金鑰：

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp", "--toolsets=invoice,stock,rail"],
      "env": {
        "TDX_CLIENT_ID": "你的 Client Id",
        "TDX_CLIENT_SECRET": "你的 Client Secret"
      }
    }
  }
}
```

4. 儲存設定並重新啟動 Claude Desktop／Cursor。

金鑰只放在本機設定，不要貼到對話裡，也不要提交到版本控制；`.env` 已列入 gitignore。以 `--toolsets=invoice,stock,rail` 或 `--toolsets=rail` 啟用；缺金鑰時，鐵路工具會顯示上述設定指引。

使用自己的金鑰在本機執行，可查即時車次與誤點。已於 2026-10-29 以真實 TDX 回應驗證。成功回覆標示資料介接「交通部TDX平臺」；詳見 [TDX 鐵路測試資料](test/fixtures/tdx/README.md)。

### 遠端版（Cloudflare Workers）

發票、台股與專案模式的鐵路時刻表讀取 KV 快照；臺鐵即時查詢經單一 TDX 閘道按需取得，失敗時顯示表訂班次。證交所與發票由 Worker cron 更新；上櫃快照由 [TPEx collector](.github/workflows/tpex-collect.yml) 寫入，鐵路快照由 [GitHub Actions rail collector](.github/workflows/rail-snapshot.yml) 寫入。Workers Free 維持每次 10 ms CPU，鐵路壓縮在 collector 執行。每 IP 每分鐘限制 30 次請求。

#### 遠端鐵路

- **A：專案金鑰。** 時刻表使用共用快照，GitHub Actions collector 於臺北時間 00:23、04:23 補齊今天與明天，車站每七天更新；時刻表查詢不呼叫 TDX。臺鐵即時資料按需取得，共用兩分鐘快取。四道上限為每分鐘四次、依剩餘天數分配的每日額度、每月 4,500 次（即時上限為 90% 減去快照保留額；預設保留 300，即時上限 3,750）、每 IP 每小時六次即時快取未命中；達上限或上游失敗就回覆表訂班次並附原因。
- **B：自備金鑰。** 在 Claude Code 的 `.mcp.json` 或 Cursor 的 `.cursor/mcp.json` 遠端連線設定加入以下 `headers`（合併到既有端點設定）：

```json
{
  "mcpServers": {
    "formosa": {
      "headers": {
        "X-TDX-Client-Id": "YOUR_CLIENT_ID",
        "X-TDX-Client-Secret": "YOUR_CLIENT_SECRET"
      }
    }
  }
}
```

自備金鑰可查其他日期與即時資料，不使用專案額度；每 IP 每分鐘 30 次的 MCP 限制仍適用。金鑰只用於該次請求，不儲存、不寫日誌；只放在用戶端私密設定，絕不可放進 URL、貼到對話或提交到版本控制。兩個 header 須一起提供，值去除前後空白後各為 1～256 個可列印 ASCII 字元。

完整專案功能須同時設定 repo secrets `TDX_CLIENT_ID`／`TDX_CLIENT_SECRET`（collector）與同名 Worker secrets（即時查詢）；collector 另需 repo secret `CLOUDFLARE_KV_WRITE_TOKEN` 與 repo variable `CLOUDFLARE_ACCOUNT_ID`。缺 TDX repo secrets 時工作流程會成功略過。

鐵路本機 bootstrap 使用 `node scripts/dist/publish-rail.mjs --out /tmp/rail --wrangler-bulk /tmp/rail-bulk.json`，再匯入本機 KV；mock 設定與完整指令見下方文件。`npm run build:collectors` 重建兩個 collector bundle。

額度公式、監控、維護者 secrets 設定及離線壓力測試見[遠端鐵路設計](docs/remote-rail.md)。

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

## 資料來源與授權

- 本專案程式碼採 [MIT](LICENSE) 授權。
- 資料依[政府資料開放授權條款第1版](https://data.gov.tw/license)使用，來源：財政部（統一發票中獎號碼）、臺灣證券交易所（TWSE OpenAPI）、證券櫃檯買賣中心（TPEx OpenAPI）、交通部 TDX 運輸資料流通服務平臺（資料介接「交通部TDX平臺」）。
- 垃圾車時刻資料來自[新北](https://data.gov.tw/dataset/125664)、[臺北](https://data.gov.tw/dataset/136515)、[臺中](https://data.gov.tw/dataset/84004)、[臺南](https://data.tainan.gov.tw/)、[高雄](https://data.gov.tw/dataset/117726)市環保局開放資料（OGDL-1）；臺北收運日依環保局公告，高雄僅提供當日班表。
- 非官方專案，與上述機關無關；資料以官方公告為準，可能延遲或有誤。
- 股票資料為盤後資料，僅供參考，不構成投資建議。

## 參與貢獻

請見 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 授權

[MIT](LICENSE)
