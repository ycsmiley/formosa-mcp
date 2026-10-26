# 台灣日常問題評估種子
比較 agent 有／沒有 formosa-mcp 時回答台灣日常問題的準確率。
目前有 20 題：發票與台股各 10 題；後續擴充鐵路問題。
Measure agent accuracy on Taiwan daily questions with and without formosa-mcp.

JSON 為物件陣列，每題欄位如下：
- `id`：唯一題號。
- `question`：使用者以 zh-TW 提出的日常問題。
- `toolset`：預期工具組。
- `expected_tool`：預期呼叫的已註冊工具名稱。
- `expected_args`：預期參數；同義期別格式可正規化。
- `expected_key_facts`：答案應包含的語意事實，不要求逐字比對。
- `notes`：評估條件、規則或例外。

與已開獎期別綁定的答案固定在 115年07-08月；換期時需更新題目與答案。
最新一期題依即時資料回答；尚未開獎題固定評估日期為 2026-10-26，開獎後需更新。
台股題以來源資料日期為準，非即時；除權息使用評估日期的台北時間過濾。
目前沒有 runner，測試只驗證資料結構與工具名稱。
