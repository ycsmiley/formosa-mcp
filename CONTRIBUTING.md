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
