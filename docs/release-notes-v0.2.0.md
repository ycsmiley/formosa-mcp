<!-- 給維護者：tag v0.2.0 尚未建立；貼到 GitHub Release 時不含此註解。 -->
# formosa-mcp v0.2.0

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
- 鐵路：`thsr_timetable`、`tra_timetable`（專案金鑰提供今天與明天的快照）、`tra_live`（額度內提供即時資料，達上限或上游失敗時回傳表訂班次）。
- `garbage_schedule`：新北、臺北、臺中垃圾車；`outage_schedule`：台水、北水、台電計畫性停水停電公告。

遠端每個 IP 每分鐘限 30 次請求。可在請求標頭 `X-TDX-Client-Id` 和 `X-TDX-Client-Secret` 放入自己的 TDX 金鑰；金鑰只用於該次請求，不儲存、不記錄。

0.2.0 的 npm 套件新增 `garbage_schedule` 和 `outage_schedule`，本機預設啟用 `invoice,stock,garbage,outage`，stdio 直接向官方來源抓資料，不需要 KV。npm 版需要 Node.js 20 以上，可用 `npx -y formosa-mcp` 啟動。

- 本機與遠端都提供發票、台股、垃圾車及停水停電工具。
- 遠端專案金鑰提供今天與明天的鐵路時刻表及額度內的 `tra_live`；自備金鑰可查其他日期。本機鐵路需設定自己的 `TDX_CLIENT_ID` 和 `TDX_CLIENT_SECRET`，並加入 `rail`，例如 `npx -y formosa-mcp --toolsets invoice,stock,garbage,outage,rail`。`--toolsets` 會取代預設清單。

災害（`disaster` 工具集）為實驗功能，預設關閉，不保證資料完整。本機可在 `--toolsets` 清單加入 `disaster`；Worker 需設定 `DISASTER_ENABLED=true`。詳見[災害工具說明](https://github.com/ycsmiley/formosa-mcp/blob/main/docs/disaster.md)。

已知限制：台股為盤後資料；台水空的匯出資料會顯示先前公告並提示資料不完整；遠端專案金鑰的鐵路時刻表僅提供今天與明天；臺南與高雄垃圾車已移除，查詢會回傳「目前尚未支援」。

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

Remote tools include `invoice_get_winning_numbers`, `invoice_check`, `stock_quote`, `stock_dividends`, `thsr_timetable`, `tra_timetable`, `tra_live`, `garbage_schedule` (New Taipei, Taipei and Taichung), and `outage_schedule` (planned Taiwan Water, Taipei Water and Taipower notices). Project-key timetables cover today and tomorrow; `tra_live` provides live data within quota and falls back to scheduled services when limits are reached or the upstream fails. The limit is 30 requests per IP per minute. Optional `X-TDX-Client-Id` and `X-TDX-Client-Secret` headers supply credentials for that request only; they are neither stored nor logged.

Version 0.2.0 adds garbage and outage tools to the npm package. Local and remote versions both provide invoice, stock, garbage and outage tools; local stdio fetches official sources directly without KV. Node.js 20+ is required. Run `npx -y formosa-mcp` to use the default `invoice,stock,garbage,outage` toolsets. Local rail requires your own `TDX_CLIENT_ID` and `TDX_CLIENT_SECRET` and an explicit selection, for example `npx -y formosa-mcp --toolsets invoice,stock,garbage,outage,rail`; `--toolsets` replaces the default list. A remote personal key also allows queries for other dates.

The `disaster` toolset is experimental, off by default and does not guarantee complete data. Add `disaster` to the local `--toolsets` list or set `DISASTER_ENABLED=true` for the Worker. See the [disaster documentation](https://github.com/ycsmiley/formosa-mcp/blob/main/docs/disaster.md).

Limitations: stocks are end-of-day; empty Taiwan Water exports result in previous notices with an incomplete-data warning; project-key remote rail timetables cover today and tomorrow only; Tainan and Kaohsiung garbage schedules were removed and queries return 「目前尚未支援」.

Sources include Taiwan's Ministry of Finance, Taiwan Stock Exchange, Taipei Exchange, local governments and utilities, under the [Open Government Data License, version 1.0](https://data.gov.tw/license); transport data is provided through「交通部TDX平臺」. This project is unofficial; official announcements prevail and stock data is not investment advice.
