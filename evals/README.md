# 台灣日常問題評估種子

比較 agent 有／沒有 formosa-mcp 時回答台灣日常問題的準確率。共有 33 題：發票 13 題、台股 13 題、鐵路 4 題、垃圾車 3 題。

JSON 是物件陣列，每題欄位如下：
- `id`：唯一題號。
- `question`：使用者以 zh-TW 提出的日常問題。
- `toolset`：預期工具組。
- `expected_tool`：預期呼叫的已註冊工具名稱。
- `expected_args`：預期參數；同義期別格式可正規化。
- `expected_key_facts`：答案應包含的語意事實，不要求逐字比對。
- `notes`：評估條件、規則或例外。
- `daily_ci`：是否納入每日即時檢查。
- `expires`（選填，`YYYY-MM-DD`）：此日期之後預期答案不再有效，必須更新題目；eval-live 對每日題目在到期前 30 天警告，過期後判定失敗。
- `requires_key`：鐵路題為 `TDX`，其他為 `null`。

固定開獎答案綁定 115年05-06月及 115年07-08月；財政部 RSS 保留最近六期，約一年後需更新。尚未開獎題 `invoice-008` 的評估日期固定為 2026-10-26，開獎後需更新；`invoice-013` 有效至 116年3月25日。
台股題以來源資料日期為準，非即時；除權息依評估日期的台北時間過濾。
鐵路題使用 `test/fixtures/tdx/synthetic` 合成資料，日期固定 2026-10-28、時區 Asia/Taipei；測試以 mocked fetch 驗證，無需金鑰或網路，四題仍待 TDX 金鑰。需明確啟用 rail；驗證工具名稱時啟用 invoice,stock,rail。`thsr_timetable`／`tra_timetable` 接受 origin/destination/date/time；`tra_live` 擇一使用 train_no 或 station。

執行 `npm run eval:live` 呼叫每日選定的發票和台股工具，檢查關鍵事實與回覆格式；不使用 LLM，也不比對固定股價。關鍵事實和字串檢查會先移除空白及冒號（：/:）再比對。每日題目為 invoice-001/002/003/005/011/012、stock-001/003/011/013；股票資料日期超過 10 個日曆日即失敗。失敗時輸出 zh-TW 摘要並以狀態碼 1 結束。GitHub Actions 每週一至週五台北時間 19:23 執行，也可手動觸發。

## English

The 39 questions cover 13 invoice, 13 stock, 4 rail, 4 garbage, and 5 outage cases. Outage cases have `daily_ci: false` because live announcements change. JSON fields: `id` (unique ID), `question` (zh-TW question), `toolset` and `expected_tool` (expected tools), `expected_args` (equivalent period formats may be normalized), `expected_key_facts` (semantic facts, not verbatim text), `notes` (conditions and exceptions), `daily_ci` (daily selection), optional `expires` (`YYYY-MM-DD`, the date after which the expected answer is no longer valid and the question must be updated; eval-live warns for daily questions within 30 days and fails after expiry), and `requires_key` (`TDX` for rail, otherwise `null`).

Fixed invoice answers use ROC 115 May–June and July–August; the MOF RSS retains six draws, so refresh them roughly a year later. The undrawn `invoice-008` uses evaluation date 2026-10-26 and must be updated after the draw; `invoice-013` is valid through ROC 116 March 25. Stock answers follow source data dates, not live prices; ex-dividend dates are filtered using the evaluation date in Taipei time.

Rail cases use synthetic `test/fixtures/tdx/synthetic` data dated 2026-10-28 in Asia/Taipei. Tests use mocked fetch without credentials or network; the four cases await a TDX key. Explicitly enable rail, or invoice,stock,rail when validating tool names. `thsr_timetable` and `tra_timetable` accept origin/destination/date/time; `tra_live` accepts either train_no or station.

Run `npm run eval:live` for invoice-001/002/003/005/011/012 and stock-001/003/011/013. It checks key facts and response shape without an LLM or fixed stock prices, removing whitespace and colons (：/:) before matching key facts and strings. Stock data older than 10 calendar days fails; failures produce a zh-TW summary and exit 1. GitHub Actions runs weekdays at 19:23 Taipei time and supports manual dispatch.
