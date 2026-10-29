# 台灣日常問題評估種子

比較 agent 有／沒有 formosa-mcp 時回答台灣日常問題的準確率。共有 30 題：發票 13 題、台股 13 題、鐵路 4 題。

JSON 是物件陣列，每題包含唯一 `id`、`question`、`toolset`、`expected_tool`、`expected_args`、`expected_key_facts` 和 `notes`。`daily_ci` 表示是否納入每日即時檢查；`requires_key` 在鐵路題為 `TDX`，其他為 `null`。

四題鐵路題待 TDX 金鑰；測試仍以 `test/fixtures/tdx/synthetic` 合成資料及 mocked fetch 驗證，無需金鑰或網路。固定開獎答案綁定 115年05-06月及 115年07-08月；財政部 RSS 保留最近六期，約一年後需更新。尚未開獎題的有效期限見各題 notes。

執行 `npm run eval:live` 呼叫每日選定的發票和台股工具，檢查關鍵事實與回覆格式；不使用 LLM，也不比對固定股價。股票資料日期不得超過 10 個日曆日。GitHub Actions 每週一至週五台北時間 19:23 執行，也可手動觸發。

## English

The 30 questions cover 13 invoice, 13 stock, and 4 rail cases. Each JSON object includes `id`, `question`, `toolset`, `expected_tool`, `expected_args`, `expected_key_facts`, and `notes`. `daily_ci` selects the daily live subset; `requires_key` is `TDX` for rail and `null` otherwise.

The four rail cases await a TDX key and still run against synthetic fixtures with mocked fetch in tests. Fixed invoice answers use the ROC 115 May–June and July–August periods; the MOF RSS retains six draws, so refresh them roughly a year later. See notes for expiry of not-yet-drawn cases.

Run `npm run eval:live` to call the selected invoice and stock tools and check key facts and response shape. It uses no LLM or fixed stock prices, and stock data must be at most 10 calendar days old. GitHub Actions runs weekdays at 19:23 Taipei time and supports manual dispatch.
