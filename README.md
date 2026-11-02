# formosa-mcp

**繁體中文** · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/formosa-mcp)](https://www.npmjs.com/package/formosa-mcp) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![CI](https://github.com/ycsmiley/formosa-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ycsmiley/formosa-mcp/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/formosa-mcp)](package.json)

讓 Claude、Cursor 等 AI 助手查台灣統一發票對獎、台股（上市＋上櫃）盤後行情與新北、臺北、臺中垃圾車時刻、計畫性停水停電，免金鑰；高鐵／台鐵遠端版提供今天與明天的時刻表。
Taiwan e-invoice lottery and TWSE/TPEx stock data for AI agents (MCP), no API key.

## 開始使用

遠端免金鑰，可查發票、台股、垃圾車、停水停電、高鐵／台鐵今天與明天的時刻表，以及額度內的臺鐵即時資料。

遠端網址：`https://<公開網址>/mcp`（公開當天會換成正式網址）

Claude（Desktop／網頁）：在「設定 → 連接器 → 新增自訂連接器」貼上網址。

Claude Code：

```sh
claude mcp add --transport http formosa "https://<公開網址>/mcp"
```

Cursor（`.cursor/mcp.json` 或 `~/.cursor/mcp.json`）與其他支援 streamable HTTP 的用戶端：

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/link/mcp/install?name=formosa&config=eyJ1cmwiOiJodHRwczovLzzlhazplovntrLlnYA%2BL21jcCJ9)
<!-- 公開當天以正式網址重新產生 config（base64） -->

```json
{
  "mcpServers": {
    "formosa": {
      "url": "https://<公開網址>/mcp"
    }
  }
}
```

### 本機執行（開發者）

需要 Node.js 20 以上。npm 版 0.1.0 包含發票、台股與鐵路預覽；垃圾車、停水停電請用遠端網址或從原始碼執行。

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

## 可以問什麼

- 「115 年 7–8 月發票 54348835 有沒有中？」
- 「這期發票特別獎幾號？」
- 「台積電收盤多少？」
- 「上櫃環球晶 6488 本益比多少？」
- 「台積電什麼時候除息？」
- 「板橋文化路垃圾車幾點來？」
- 「信義區下週有沒有停電？」

## 功能

- 發票：可用，查中獎號碼、領獎期間與對獎。
- 台股：可用，涵蓋上市＋上櫃；盤後資料，非即時，行情顯示資料日期。
- 高鐵／台鐵：遠端版預設提供今天與明天的時刻表、額度內的臺鐵即時資料；本機版見[鐵路說明](#鐵路金鑰)。
- 垃圾車：查詢新北、臺北、臺中定點收運時刻；請提供行政區與里名、路名或地點。
- 停水停電：`outage` 工具集查台水、北水、台電計畫性公告，支援縣市、行政區、路名與最多 31 天的日期區間。
- 氣象：規劃中。

工具：

- `invoice_get_winning_numbers {period?}`：查最新或指定期別號碼、領獎期間；未公布期別顯示「尚未開獎」。
- `invoice_check {number, period?}`：接受 3–8 碼及兩碼英文字母前綴，3–7 碼只能判斷六獎；省略期別時檢查最新一期與仍可領獎的前一期。
- `stock_quote {query}`：以代號或名稱查上市／上櫃收盤、漲跌、成交量、本益比、殖利率與股價淨值比；名稱有多筆符合時列出代號供選擇。
- `stock_dividends {query?}`：列出近期除權息，預設前 20 筆；可指定股票代號或名稱。
- `thsr_timetable {origin, destination, date?, time?}`：高鐵起迄站時刻。
- `tra_timetable {origin, destination, date?, time?}`：台鐵時刻、車種、停駛與加班車。
- `garbage_schedule {city, district?, keyword?, weekday?, time?}`：定點收運時刻。
- `outage_schedule {city, district?, keyword?, type?, start_date?, end_date?}`：計畫性停水停電，`type` 為 `water`、`power` 或 `all`（預設）；省略日期時查臺北時間今天起七天，最多顯示 30 筆。
- `work_school_closure {city}`：查縣市今天／明天的天然災害停班停課官方原文；`disaster` 工具集，預設啟用。
- `disaster_alerts {city}`：查縣市生效中的 NCDR 告警（含地震、停水），依嚴重度排序，最多顯示 20 則。新竹／嘉義未指定市縣時兩者都列出。
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

`--toolsets=invoice,stock` 啟用發票與台股，也可只選一組；預設啟用 `invoice`、`stock`、`garbage`、`outage`、`disaster` 五組，鐵路須明確啟用。`--help` 顯示用法。

資料來源與快取：

- [財政部 RSS](https://invoice.etax.nat.gov.tw/invoice.xml)：免金鑰，最近 6 期，快取 6 小時；單數月 25 日若新期尚未公布，改為 10 分鐘。依已公布資料回答。
- [證交所 OpenAPI](https://openapi.twse.com.tw/)及[櫃買中心 OpenAPI](https://www.tpex.org.tw/openapi/)：免金鑰，各資料集快取 1 小時，兩個股票工具共用；單一市場無法連線時仍回覆另一市場並附註。

停水停電本機收集：`npm run collect:outages -- --out /tmp/formosa-outages`；設 `FORMOSA_OUTAGE_DIR=/tmp/formosa-outages` 供 stdio 讀取。未設時在 Node 程序抓取相關來源，成功快取 12 小時，失敗立即允許重試。collector bundle 以 `npm run build:collectors` 產生，plugin bundle 以 `npm run build:plugin` 更新後提交。

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

發票、台股與專案模式的鐵路時刻表讀取 KV 快照；臺鐵即時查詢經單一 TDX 閘道按需取得，失敗時顯示表訂班次。證交所與發票由 Worker cron 更新；上櫃快照由 [TPEx collector](.github/workflows/tpex-collect.yml) 寫入，鐵路快照由 [GitHub Actions rail collector](.github/workflows/rail-snapshot.yml) 寫入。[垃圾車 collector](.github/workflows/garbage-collect.yml) 於臺北時間 11:37 更新三市。[停水停電 collector](.github/workflows/outage-collect.yml) 每天 06:23、12:23、18:23（臺北時間）抓取三個來源，以 `outage:v1:{source}:{county}:{sha12}`（SHA-256 前 12 碼）寫入依內容固定的縣市分片，KV TTL 為 8 天（目錄模式忽略 TTL）；索引縣市條目記錄 `writtenAt`，相同內容僅在距上次寫入超過 3 天時續寫，失敗來源保留原縣市條目，最後每次寫入 `outage:index:v1` 索引心跳。Worker 從索引雜湊組出分片 key，僅讀 KV，不解析 ZIP／CSV，也不增加 Worker cron。Workers Free 維持每次 10 ms CPU，鐵路壓縮在 collector 執行。每 IP 每分鐘限制 30 次請求。

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

停班停課與告警採雙層收集：Worker 新增唯一一條 `5,15,25,35,45,55 * * * *` cron（每 10 分鐘 x5，臺北／UTC 分鐘相同），NCDR 請求只在本輪開始後 60 秒內發出，每輪最多 4 個 CAP。[GHA collector](.github/workflows/disaster-collect.yml) 每小時 `20 * * * *` 執行（最多 20 個 CAP）；逐來源檢查 Worker 的 `lastSuccessAt`，距今 ≤25 分鐘便跳過該來源，但仍寫 GHA 心跳。延遲啟動的 GHA 在每次 NCDR 請求前避開每 10 分鐘的 x4:30～x7:00，等到 x7:00 才送出。所有 NCDR 請求（JSON feed、Atom 備援、CAP）都在前一回應結束後至少等 3.1 秒，避免官方每 IP 3 秒限制。此安排為錯開請求，並非跨程序鎖。兩個 feed 同時要求登入時顯示「尚未支援」，不使用金鑰。

Cloudflare 出口 IP 能否連到 DGPA／NCDR 尚待部署驗證；若 Worker 無法取得，改由每小時 GHA 快照兜底。讀取時逐來源選兩個 writer 中最近成功的資料；抓取超過 90 分鐘會警示，DGPA 官方頁面更新時間超過 90 分鐘也會警示。停班停課保留官方原文，不推論出勤狀態；過期時隱藏含「照常」的原文，以不顯示的提示取代，頁面日期與今天不同另行提示。過期的零則告警不宣稱目前沒有告警，停班停課無事件頁面則明示為當時狀態。摘要會以無歧義的鄉鎮市區名稱補判縣市；尚無法判定範圍的告警會提示無法確認是否涵蓋查詢縣市，CAP 詳細告警會列出該縣市範圍（最多 15 處）。來源更新時間與本服務抓取時間分列，失敗不冒充沒有事件。

KV 使用獨立索引 `disaster:index:worker:v1`、`disaster:index:gha:v1`，避免兩個 writer 互相覆蓋；內容分片為 `disaster:v1:dgpa:{sha12}`、`disaster:v1:ncdr:{sha12}`（編碼內容 SHA-256 前 12 碼）。分片不含頁面／feed 更新時間（存索引），TTL 8 天，相同內容僅超過 3 天才續寫（Worker 配合下一次索引心跳），`writtenAt` 記錄續期時間。分片先寫、索引最後寫；來源失敗保留原 sha、count、寫入／成功／來源更新時間；有效的零則 NCDR feed 可寫空分片。

KV 寫入預算：內容／ok／closed／reason 不變時 Worker 索引至少隔 19 分鐘才寫（x5 排程約每 20 分鐘，72 次／日），心跳採本輪開始時間，避免慢回應使第二輪錯過門檻；GHA 每輪寫索引（24 次／日），通常合計 96 次／日，加上分片變動／續期。若每輪兩個來源內容皆變，Worker 最多 144×3＝432 次／日，GHA 最多 24×3＝72 次／日，disaster 合計最壞 504 次／日（不含手動執行）；狀態變動可立即寫索引，因此 72 並非絕對上限。此額度與其他 collectors 共用 Workers Free 每日 1,000 次寫入。

本機執行 `npm run collect:disaster -- --out /tmp/formosa-disaster`，再設 `FORMOSA_DISASTER_DIR=/tmp/formosa-disaster` 供 stdio 讀取。未設時 Node 按查詢來源獨立執行共用 collector、最多 6 個 CAP，每次請求逾時 12 秒，成功快取 10 分鐘、失敗快取 2 分鐘並保留失敗原因及先前成功資料；停班停課查詢不等候 NCDR，不採 GHA 的 peer skip 或 quiet window。更新 publisher 後由 `npm run build:collectors` 重建 `scripts/dist/`，workflow 直接執行已提交的 bundle。

## 資料來源與授權

- 停班停課：[行政院人事行政總處 DGPA 官方頁面](https://www.dgpa.gov.tw/typh/daily/nds.html)，政府網站內容；無官方機器可讀版。災防告警：[NCDR 民生示警公開資料平臺](https://alerts.ncdr.nat.gov.tw/)，匿名 JSON／Atom feed 標示 `rights: Public Domain`；CAP 提供範圍、等級與有效時間，優先於 feed 摘要。

- 計畫性停水停電：[台水](https://data.gov.tw/dataset/6050)、[北水](https://data.gov.tw/dataset/128236)、[台電](https://data.gov.tw/dataset/26144)，採政府資料開放授權條款第1版（OGDL-1）。北水涵蓋臺北與部分新北，台水用於臺北市以外；台電開放資料未涵蓋連江縣。
- 僅提供計畫性公告，不包含即時供應狀態、緊急搶修、事故、颱風、通知或水質。台水官方開放資料目前回傳空清單，台水結果可能不完整，請至[台水停水公告查詢系統](https://web.water.gov.tw/wateroff/)查詢；無法解析的公告時間保留原文，仍列入日期查詢，資料超過 24 小時會警示。請以台電 1911、台水 1910、北水 1999（臺北市外 02-27371999）及官方網站為準。
- 本專案程式碼採 [MIT](LICENSE) 授權。
- 資料依[政府資料開放授權條款第1版](https://data.gov.tw/license)使用，來源：財政部（統一發票中獎號碼）、臺灣證券交易所（TWSE OpenAPI）、證券櫃檯買賣中心（TPEx OpenAPI）、交通部 TDX 運輸資料流通服務平臺（資料介接「交通部TDX平臺」）。
- 垃圾車時刻資料來自[新北](https://data.gov.tw/dataset/125664)、[臺北](https://data.gov.tw/dataset/136515)、[臺中](https://data.gov.tw/dataset/84004)市環保局開放資料（OGDL-1）；臺北收運日依環保局公告。臺南、高雄尚未支援：市府開放資料站只接受台灣連線，雲端收集器無法取得資料。
- 非官方專案，與上述機關無關；資料以官方公告為準，可能延遲或有誤。
- 股票資料為盤後資料，僅供參考，不構成投資建議。

## 參與貢獻

請見 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 授權

[MIT](LICENSE)

[想要哪種台灣資料？](https://github.com/ycsmiley/formosa-mcp/issues/new?template=data-request.yml)
