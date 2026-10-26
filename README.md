# formosa-mcp

讓 Claude、Cursor、OpenClaw 等主流 agent 都懂台灣：一行安裝，查得到高鐵、發票、台股、氣象。

目前可用：發票對獎。高鐵、台股、氣象開發中。

<!-- TODO: 30 秒示範 GIF -->
<!-- ![demo](docs/demo.gif) -->

安裝（發布後可用；需要 Node.js 20 以上）：

```sh
npx formosa-mcp
```

本機執行（將 `<owner>` 換成實際擁有者）：

```sh
git clone https://github.com/<owner>/formosa-mcp && cd formosa-mcp && npm install && npm run build && node dist/index.js
```

## MCP client 設定

Claude Desktop / Cursor 的 `mcpServers` 設定（發布後可用）：

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp", "--toolsets=invoice"]
    }
  }
}
```

本機版本：先完成建置，將路徑換成實際的絕對路徑。

```json
{
  "mcpServers": {
    "formosa": {
      "command": "node",
      "args": ["/absolute/path/formosa-mcp/dist/index.js", "--toolsets=invoice"]
    }
  }
}
```

## 功能

- `invoice_get_winning_numbers {period?}`：查最新或指定期別號碼、領獎期間；未公布期別顯示「尚未開獎」。
- `invoice_check {number, period?}`：接受 3–8 碼及兩碼英文字母前綴，3–7 碼只能判斷六獎；省略期別時檢查最新一期與仍可領獎的前一期。

## 工具組開關

使用 `--toolsets=invoice` 啟用發票工具組；未指定時啟用所有已實作工具組，目前只有 invoice。

```sh
node dist/index.js --toolsets=invoice
```

## 資料來源

[財政部 RSS](https://invoice.etax.nat.gov.tw/invoice.xml)，免金鑰，只含最近 6 期，6 小時快取。每逢單數月 25 日開獎；實際查詢依財政部已公布資料回答。

## 開發

```sh
npm install
npm run build
npm test
npm run live-check
```

`live-check` 會建置並透過 MCP SDK 啟動實際 server，連線財政部驗證工具；需要網路。
評估題目與欄位說明見 [evals/README.md](evals/README.md)，目前沒有評估 runner。

## English

formosa-mcp is a TypeScript MCP server for Taiwan daily information.
Invoice lookup and checking are available; rail, stocks, and weather are in development.
Requires Node.js 20 or later. After publication, run `npx formosa-mcp`.
For local use, install dependencies, run `npm run build`, then `node dist/index.js`.
Configure your MCP client with the examples above; select invoices with `--toolsets=invoice`.
Invoice data comes from the Ministry of Finance RSS, requires no API key, and is cached for six hours.
Run `npm test` for tests and `npm run live-check` for a live MCP check.

## License

MIT
