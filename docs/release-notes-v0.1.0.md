<!-- 給維護者：tag v0.1.0 指向 173e67e；貼到 GitHub Release 時不含此註解。 -->
# formosa-mcp v0.1.0

## 繁體中文

formosa-mcp 讓 AI 助手查詢台灣發票、台股、交通及公共服務資料。

使用遠端服務：在 Claude 的自訂連接器貼上以下網址；Claude Code 可執行以下指令：

<!-- 公開當天換成正式網址 -->
```sh
claude mcp add --transport http formosa "https://<公開網址>/mcp"
```

Cursor 的 MCP 設定：

<!-- 公開當天換成正式網址 -->
```json
{"mcpServers":{"formosa":{"url":"https://<公開網址>/mcp"}}}
```

遠端工具：

- 發票：`invoice_get_winning_numbers`、`invoice_check`；台股：`stock_quote`、`stock_dividends`。
- 鐵路：`thsr_timetable`、`tra_timetable`（今天與明天的專案金鑰快照）、`tra_live`（額度內提供即時資料，超過額度時回傳表訂班次）。
- `garbage_schedule`：新北、臺北、臺中垃圾車；`outage_schedule`：台水、北水、台電計畫性停水停電公告。

遠端每個 IP 每分鐘限 30 次請求。可在請求標頭 `X-TDX-Client-Id` 和 `X-TDX-Client-Secret` 放入自己的 TDX 金鑰；金鑰只用於該次請求，不儲存、不記錄。

npm 0.1.0 本機套件可用 `npx -y formosa-mcp` 啟動，預設提供 `invoice_get_winning_numbers`、`invoice_check`、`stock_quote`、`stock_dividends`。`thsr_timetable`、`tra_timetable`、`tra_live` 須以 `--toolsets rail` 啟用並自備 TDX 金鑰；設定環境變數 `TDX_CLIENT_ID` 和 `TDX_CLIENT_SECRET`。npm 版不含垃圾車與停水停電工具。

已知限制：台股為盤後資料；台水官方資料目前為空，停水資料可能不完整；臺南與高雄垃圾車尚未支援；遠端鐵路時刻表僅提供今天與明天。

資料來源包括財政部、臺灣證券交易所、證券櫃檯買賣中心、地方政府及公用事業資料，並依[政府資料開放授權條款第1版](https://data.gov.tw/license)使用；資料介接「交通部TDX平臺」。本專案為非官方專案，資料以官方公告為準，股票資料不構成投資建議。

## English

formosa-mcp lets AI assistants look up Taiwan invoice, stock, transport and public service data.

For the remote service, paste the URL into a Claude custom connector, or use Claude Code:

<!-- 公開當天換成正式網址 -->
```sh
claude mcp add --transport http formosa "https://<公開網址>/mcp"
```

Cursor MCP configuration:

<!-- 公開當天換成正式網址 -->
```json
{"mcpServers":{"formosa":{"url":"https://<公開網址>/mcp"}}}
```

Remote tools: `invoice_get_winning_numbers`, `invoice_check`, `stock_quote`, `stock_dividends`, `thsr_timetable`, `tra_timetable`, `tra_live`, `garbage_schedule` (New Taipei, Taipei and Taichung), and `outage_schedule` (planned Taiwan Water, Taipei Water and Taipower notices). Timetables use project-key snapshots for today and tomorrow; `tra_live` provides live data within quota and scheduled services when the quota is exceeded.

The remote limit is 30 requests per IP per minute. Optional `X-TDX-Client-Id` and `X-TDX-Client-Secret` headers supply your own TDX credentials for that request only; they are neither stored nor logged.

Run npm 0.1.0 locally with `npx -y formosa-mcp`. It enables `invoice_get_winning_numbers`, `invoice_check`, `stock_quote` and `stock_dividends` by default. To use `thsr_timetable`, `tra_timetable` and `tra_live`, enable `--toolsets rail` and provide your own `TDX_CLIENT_ID` and `TDX_CLIENT_SECRET` environment variables. The npm version has no garbage collection or outage tools.

Limitations: stock data is end-of-day; Taiwan Water's official data is currently empty, so water outage data may be incomplete; garbage collection in Tainan and Kaohsiung is not yet supported; remote rail timetables cover today and tomorrow only.

Sources include Taiwan's Ministry of Finance, Taiwan Stock Exchange, Taipei Exchange, local governments and utilities, under the [Open Government Data License, version 1.0](https://data.gov.tw/license); transport data is provided through「交通部TDX平臺」. This project is unofficial; official announcements prevail and stock data is not investment advice.
