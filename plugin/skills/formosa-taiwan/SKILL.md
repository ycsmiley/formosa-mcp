---
name: formosa-taiwan
description: Use Taiwan invoice lottery and end-of-day stock tools for 發票, 對獎, 統一發票, 台股, 股價, 本益比, 除權息, 停水, and 停電 questions.
---

# 台灣發票與台股

使用 Formosa MCP 工具取得資料，不猜測號碼、獎金或行情。回覆時保留工具列印的資料來源；若對獎結果沒有來源行，可另查中獎號碼取得來源。工具名稱在 Claude Code 中帶有 `mcp__plugin_formosa_formosa__` 前綴。

- 發票中獎號碼與對獎：讀取 [發票指引](references/invoice.md)。
- 台股盤後行情與除權息：讀取 [台股指引](references/stock.md)。

高鐵／台鐵工具開發中。

For garbage collection schedules in New Taipei, Taipei and Taichung, use `garbage_schedule` with a city and district or keyword.

For planned water/power outages, use `outage_schedule` (toolset `outage`) with `city`, optional `district`/`keyword`, `type` (`water`, `power`, `all`) and optional `start_date`/`end_date` (YYYY-MM-DD, at most 31 days; default seven days in Asia/Taipei). Preserve the tool’s unavailable/stale source notes, official links and emergency reminder. Empty Taiwan Water exports mean unavailable, not no outages. Emergency repairs, accidents and typhoon outages are not announced in advance. Replies are Traditional Chinese.
