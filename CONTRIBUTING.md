# 貢獻指南

Worker 測試需要 Node.js 22。安裝依賴請執行 `npm ci`，提交前請執行 CI 的五項檢查：

```sh
npm ci
npm run build
npm test
npm run typecheck:worker
npm run test:worker
```

變更 `src` 時，請執行 `npm run build:plugin`；已提交的 `plugin/server/formosa-mcp.mjs` 必須與產生的 bundle 逐位元組一致，測試會檢查。請同步維護 `README.md` 與 `README.en.md`，保持相同的標題與順序。工具回覆應為格式化的繁體中文文字，而非原始 JSON。新增資料來源須為官方開放資料並註明授權。

切勿提交金鑰；`.env` 已加入 gitignore，TDX 金鑰使用環境變數 `TDX_CLIENT_ID` 和 `TDX_CLIENT_SECRET`。安全問題請依 [SECURITY.md](SECURITY.md) 私下通報，勿開公開 issue。

## English

Use Node.js 22 for Worker tests and run the five checks above. Rebuild the committed plugin bundle with `npm run build:plugin` after changing `src`; a test checks byte-for-byte consistency. Keep both READMEs' headings and order in sync, return formatted Traditional Chinese text from tools, and use official open data with its licence noted. Never commit keys; use the TDX environment variables above. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## 新工具的 CI 契約 / New-tool CI contract

每個新工具都必須在 `test/output-contract-fixtures.ts` 加入 fixture case，並通過本機與 Worker 的 `listTools()` 列舉檢查；工具回覆必須包含有意義的資料來源與資料時間，不得直接輸出或夾帶上游 JSON／原始欄位。讀取 snapshot／KV 的工具也須加入 `snapshotReaders` 與 stale fixture，依既有門檻驗證過期警告。這些測試沿用上述 `npm test`、`npm run test:worker`，不增加 CI job。

CI 另在每次 push／PR 執行 gitleaks；每日即時評測以 90% 為通過門檻，低於門檻或無有效結果時會讓 job 失敗，並建立／更新 `eval-regression` issue（臺北日期每天至多一則）。目前基準為 10 題全對，容許一題上游波動。

Every new tool needs a fixture case in `test/output-contract-fixtures.ts`; both local and Worker suites enumerate `listTools()` and reject missing or obsolete cases. Replies must include a meaningful data source and data time, and must contain neither raw upstream JSON nor leaked upstream field names. Snapshot/KV readers also need an entry in `snapshotReaders` and a stale fixture that verifies the warning using existing thresholds. These suites run in the existing test job through `npm test` and `npm run test:worker`.

Gitleaks runs on every push and PR. Daily live eval requires 90% accuracy (current baseline: 10/10; one-question headroom for upstream flakiness). A lower score or missing/invalid result fails the job and creates or updates one open `eval-regression` issue, with at most one entry per Taipei day. `EVAL_RESULT_PATH=/tmp/eval-result.json npm run eval:live` writes the result; `npx tsx scripts/eval-threshold.ts --result /tmp/eval-result.json --dry-run` previews the exact action without network. Add `--state /path/state.json` with `{ "issues": [{ "number": 6, "body": "" }], "comments": { "6": [] }, "labelExists": true }` to preview reuse/deduplication. Only the threshold step receives the short-lived `GITHUB_TOKEN`.
