# TDX 鐵路離線 fixtures / Offline rail fixtures

所有 JSON 均為本機文件範例或合成資料，**不是即時資料，也不是已驗證的實際班表**。未使用 API 金鑰，未呼叫任何 TDX endpoint。

## 文件範例 doc-examples

來源（已下載文件；本次只讀本機檔案）：

- [TDX Rail V2 OpenAPI](https://tdx.transportdata.tw/webapi/File/Swagger/V3/268fc230-2e04-471b-a728-a726167c1cfc)：`thsr-stations.json`、`thsr-od.json`。
- [TDX Rail V3 OpenAPI](https://tdx.transportdata.tw/webapi/File/Swagger/V3/5fa88b0c-120b-43f1-b188-c379ddb2593d)：`tra-stations.json`、`tra-od.json`、`tra-train-live.json`、`tra-station-live.json`。
- [TDX SampleCode README](https://github.com/tdxmotc/SampleCode)：`token.json`，節錄 token response 的三個已列出欄位，保留原文假 token `eyJh...`；省略敘述性佔位文字，不含真實憑證。

Swagger 沒有明確 example。`scripts/tdx-doc-examples.mjs` 從 GET 200 application/json response schema 展開 `$ref`、`allOf`、properties，模擬 Swagger UI Example Value：string → `"string"`、integer/number → `0`、boolean → `true`、array → 一個 item。包含選填欄位，不從服務抓資料，不在 tests 執行。這些佔位值不表示有效站名、日期、時間、車次或 Count；parser 遇無效欄位應回覆清楚錯誤。

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

TrainDate 當作營運日。到達時刻小於出發時刻時，到達加 1440 分，這是跨午夜的證據，不標推定。有任一跨夜訊號（TRA 非空 OverNightStationID 或 THSR Overnight=true）時，未由回捲解釋的 12:00 前時刻推定為隔日；出發移日則到達一併移日，以維持行程小於 24 小時。12:00 起的時刻不單獨移日，因此 21:00→22:00、23:00→23:30 不會多加一天。跨夜站等於 OD 起站／迄站也套用相同規則，例如起站 23:55 不移日。只有中午規則造成的移日標示「跨夜日序依時刻推定」。這是 OD 僅兩站資訊下的假設，不是文件保證。隔日出發加 1440 分後排序與篩選，00:40／00:45 排在同營運日晚班後。`time` 接受 00:00～29:59，24:00–29:59 表示營運日隔日凌晨；超過 10 班時，提示第一筆未顯示班次的出發時間，隔日使用 24+ 格式。

## 有金鑰後 TODO（本次不註冊、不連線）

- 本機 OpenAPI 文件中，六個資料端點的 `$top` 預設均為 30。本實作明送 `$top=1000`；站表、班表、即時列數達此上限時提示「資料可能未完整（已達單次上限）」，不做 `$skip` 分頁。TODO：有金鑰後驗證真實上限與分頁行為。
- 核對真實 StationID、英文名與跨服務站號差異。
- 核對 TRA 實際跨夜 shapes、跨夜站代碼代表午夜前或後的站，以及 OD 站序能否推知日期；必要時改用額外全程班表資訊，移除時刻推定。
- 核對 THSR `Overnight` 的真正語意（整車次／OD 區間、隔日出發）與是否存在跨夜服務。
- 核對 token 有效期與錯誤碼，維持共用快取（每 IP 每分鐘最多 20 次 token requests）。

## 標示來源 / Attribution

每個成功的 rail 回覆最後一行必須為：資料介接「交通部TDX平臺」

規範來源：[TDX 資料使用常見問題](https://motc-ptx.gitbook.io/tdx-xin-shou-zhi-yin/api-shi-yong-shuo-ming/zi-liao-shi-yong-chang-jian-wen-ti)、[政府資料開放授權條款](https://data.gov.tw/license)。
