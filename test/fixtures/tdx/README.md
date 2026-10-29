# TDX 鐵路離線 fixtures / Offline rail fixtures

JSON 分為文件範例、合成資料與真實回應快照；均供離線測試，**不是即時查詢結果**。測試與示範不需要金鑰，也不會呼叫 TDX endpoint。

## 真實回應 real/

維護者使用自己的金鑰於 2026-10-29 約 18:18（Asia/Taipei）擷取。僅裁切陣列，保留的記錄未修改；檔案不含憑證。

- `thsr-stations.json`：v2 陣列，12 站。
- `thsr-od-1000-1070.json`：v2 臺北→左營 OD 陣列子集，保留四位車次及 HH:mm 時刻。
- `tra-stations.json`：v3 Stations 子集，包含臺北與臺北-環島兩個不同站號。
- `tra-od-1000-4400.json`：v3 臺北→高雄 TrainTimetables 子集，含跨日站在 OD 區間外的 149 次及區間內的 281 次。
- `tra-station-live-1000.json`、`tra-train-live-2037.json`：v3 臺北看板及 2037 次即時位置快照；看板原始列未按時間排序，表訂時刻為 HH:mm:ss。

`test/rail-real.test.ts` 使用固定時鐘 2026-10-29 18:18（Asia/Taipei）與 mocked HTTP／token 驗證這些回應，全程離線。

## 文件範例 doc-examples

來源（已下載文件；本次只讀本機檔案）：

- [TDX Rail V2 OpenAPI](https://tdx.transportdata.tw/webapi/File/Swagger/V3/268fc230-2e04-471b-a728-a726167c1cfc)：`thsr-stations.json`、`thsr-od.json`。
- [TDX Rail V3 OpenAPI](https://tdx.transportdata.tw/webapi/File/Swagger/V3/5fa88b0c-120b-43f1-b188-c379ddb2593d)：`tra-stations.json`、`tra-od.json`、`tra-train-live.json`、`tra-station-live.json`。
- [TDX SampleCode README](https://github.com/tdxmotc/SampleCode)：`token.json`，節錄 token response 的三個已列出欄位，保留原文假 token `eyJh...`；省略敘述性佔位文字，不含真實憑證。

Swagger 沒有明確 example。`scripts/tdx-doc-examples.mjs` 從 GET 200 application/json response schema 展開 `$ref`、`allOf`、properties，模擬 Swagger UI Example Value：string → `"string"`、integer/number → `0`、boolean → `true`、array → 一個 item。包含選填欄位，不從服務抓資料，不在 tests 執行。這些佔位值不表示有效站名、日期、時間、車次或 Count；parser 會略過不完整的班次資料並提示。

重建方式（檔案已存入 repo）：

```sh
node scripts/tdx-doc-examples.mjs /path/openapi-rail-v2.json '/v2/Rail/THSR/Station' > test/fixtures/tdx/doc-examples/thsr-stations.json
node scripts/tdx-doc-examples.mjs /path/openapi-rail-v2.json '/v2/Rail/THSR/DailyTimetable/OD/{OriginStationID}/to/{DestinationStationID}/{TrainDate}' > test/fixtures/tdx/doc-examples/thsr-od.json
node scripts/tdx-doc-examples.mjs /path/openapi-rail-v3.json '/v3/Rail/TRA/Station' > test/fixtures/tdx/doc-examples/tra-stations.json
node scripts/tdx-doc-examples.mjs /path/openapi-rail-v3.json '/v3/Rail/TRA/DailyTrainTimetable/OD/{OriginStationID}/to/{DestinationStationID}/{TrainDate}' > test/fixtures/tdx/doc-examples/tra-od.json
node scripts/tdx-doc-examples.mjs /path/openapi-rail-v3.json '/v3/Rail/TRA/TrainLiveBoard/TrainNo/{TrainNo}' > test/fixtures/tdx/doc-examples/tra-train-live.json
node scripts/tdx-doc-examples.mjs /path/openapi-rail-v3.json '/v3/Rail/TRA/StationLiveBoard/Station/{StationID}' > test/fixtures/tdx/doc-examples/tra-station-live.json
```

## 合成資料 synthetic

**Synthetic files are NOT live data.** 手工設計、依 schema 使用欄位名稱／型別：同名檔案分別為站表、OD、即時看板、假 token。THSR 12 站；TRA 14 站子集。站號僅供測試示意，不可作為真實站號依據。

THSR 臺北→左營，營運日 2026-10-28：未排序、同時刻車次、22:00 晚班、23:10→隔日 01:10（120 分）、隔日 00:40→02:30。跨夜高鐵為假設的特殊加開情境，**不主張實際存在此班次**。TRA 臺北→高雄：123 次 21:30→隔日 02:15（285 分）、115 次停駛、117 次部分停駛、8121 次加班車、125 次於跨夜站臺北隔日 00:45 出發。即時資料為不同時刻的獨立快照：8121 次於 14:00 在臺中已離站、晚 5 分（臺北 12:00→高雄 16:15 區間內）；101 次於 06:00 在臺北在站上、準點。車站看板為 05:55 快照：101 次表訂 06:00 準點、8121 次表訂 12:00 晚 5 分、115 次表訂 10:00 取消，時刻與合成班表一致。

## 營運日與跨夜假設

TrainDate 當作營運日。到達時刻小於出發時刻時，到達加 1440 分，這是跨午夜的證據，不標推定。有任一跨夜訊號（TRA 非空 OverNightStationID 或 THSR Overnight=true）時，12:00 前的出發時刻推定為隔日；出發移日則到達一併移日，以維持行程小於 24 小時。12:00 起的時刻不單獨移日，因此 21:00→22:00、23:00→23:30 不會多加一天。跨夜站等於 OD 起站／迄站也套用相同規則，例如起站 23:55 不移日。只有中午規則造成的移日標示「跨夜日序依時刻推定」。此 noon fallback 用於起站時間已在跨日站之後的情境，仍是 OD 僅兩站資訊下的推定，不是文件保證；擷取的真實資料未觀察到此情境。隔日出發加 1440 分後排序與篩選，00:40／00:45 排在同營運日晚班後。`time` 接受 00:00～29:59，24:00–29:59 表示營運日隔日凌晨；超過 10 班時，提示第一筆未顯示班次的出發時間，隔日使用 24+ 格式。

## 查詢與離線示範

站名、英文名及站號可使用；支援台／臺、北車，高鐵「高雄」解析為左營並提示。日期接受 YYYY-MM-DD、YYYY/MM/DD、今天／明天／後天及民國 115-10-28；未指定日期或當日時間使用 Asia/Taipei 現在時間，其他日期從 00:00 起。時間格式為 HH:mm（00:00～29:59）。最多顯示 10 班。

站表快取 24 小時；token 於有效期前更新並共用併發請求，API 401 僅重試一次。

`npm run rail-demo` 全程離線：先啟動真正的 stdio server（`--toolsets rail`，強制清空兩項 TDX 金鑰）展示缺金鑰訊息，再以 in-process MCP client、固定時鐘及 mocked fetch 展示三個工具，包含兩種即時查詢。Fixture 注入透過 `createServer({ railHttp })`；開發用 loader 位於 scripts，src 不引用它，沒有 CLI、工具參數或環境變數能切換 fixture。不需要金鑰，也不會呼叫 TDX。

## 真實驗證結果（2026-10-29）

- `$top=1000` 已被接受：完整回應的 THSR OD 為 72 筆、TRA OD 為 32 筆、TRA 站表為 245 站，均低於 1000；`real/` 的 OD 與 TRA 站表只保留子集。維持 THSR v2／TRA v3 路徑。站表、班表、即時列數達上限時提示「資料可能未完整（已達單次上限）」，不做 `$skip` 分頁。
- StationID：THSR 1000 台北、1070 左營；TRA 1000 臺北、1001 臺北-環島、4400 高雄、4340 新左營。查詢「臺北」須解析為 1000。
- TRA `OverNightStationID` 是列車跨午夜的站，可能在 OD 區間外。149 次於 4440 鳳山跨日，但臺北→高雄是 18:59→23:57，不需移日；281 次於 4340 新左營跨日，臺北→高雄是 19:30→隔日 00:21，行程 4 小時 51 分。真實 OD 時刻列在列車起始 `TrainDate` 下；arrival < departure 的回捲規則可得到正確隔日到達，兩班均不標推定。
- THSR `Overnight` 欄位存在，當天 72 班均為 false；本快照未驗證實際跨夜高鐵服務。
- token `expires_in` 為 86400 秒；測試使用假 token，不保存真實 token 或金鑰。維持共用快取與有效期前更新。

## 標示來源 / Attribution

每個成功的 rail 回覆最後一行必須為：資料介接「交通部TDX平臺」

規範來源：[TDX 資料使用常見問題](https://motc-ptx.gitbook.io/tdx-xin-shou-zhi-yin/api-shi-yong-shuo-ming/zi-liao-shi-yong-chang-jian-wen-ti)、[政府資料開放授權條款](https://data.gov.tw/license)。
