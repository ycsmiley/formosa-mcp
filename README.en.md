# formosa-mcp

[繁體中文](README.md) · **English**

[![npm](https://img.shields.io/npm/v/formosa-mcp)](https://www.npmjs.com/package/formosa-mcp) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![CI](https://github.com/ycsmiley/formosa-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ycsmiley/formosa-mcp/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/formosa-mcp)](package.json)

Taiwan e-invoice lottery and TWSE/TPEx end-of-day stock data and garbage truck schedules for New Taipei, Taipei and Taichung for AI assistants, with no API key; remote HSR and TRA provide timetables for today and tomorrow.

## Get started

Node.js 20+ is required.

Add this configuration to Claude Desktop's `claude_desktop_config.json` or Cursor's `.cursor/mcp.json` (or `~/.cursor/mcp.json`), then restart the app:

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add formosa -- npx -y formosa-mcp
```

Claude Code plugin:

```sh
claude plugin marketplace add ycsmiley/formosa-mcp
claude plugin install formosa@formosa-mcp
```

Invoices and stocks need no key; for HSR and TRA see the [rail section](#remote-rail).

A keyless public URL is coming soon; you will be able to paste it into a Claude custom connector.

## What can I ask?

- “Did invoice 54348835 win in the July–August 2026 draw (ROC 115)?”
- “What is this period's special prize number?”
- “What was TSMC's closing price?”
- “What is the P/E ratio for OTC stock GlobalWafers 6488?”
- “When is TSMC's ex-dividend date?”
- “When does the garbage truck reach Wenhua Road in Banqiao?”

## Features

- Invoices: winning numbers, claim periods and number checks.
- Stocks: TWSE and TPEx end-of-day data; quotes show the data date.
- HSR / TRA: remote timetables for today and tomorrow, plus TRA live data within quota; for local use, see the [rail section](#railway-keys).
- Garbage trucks: scheduled stops in New Taipei, Taipei and Taichung; give a district plus a village, road or place.
- Weather: planned.

Tools:

- `invoice_get_winning_numbers {period?}`: winning numbers and claim periods; unpublished periods are marked as not yet drawn.
- `invoice_check {number, period?}`: checks 3–8 digits and optional two-letter prefix; 3–7 digits can only identify sixth prizes. By default checks the latest draw and any previous draw still claimable.
- `stock_quote {query}`: closing price, changes, volume, P/E, yield and price-to-book; lists matching codes for ambiguous names.
- `stock_dividends {query?}`: recent ex-dividend dates, defaulting to 20 results; optionally filter by code or name.
- `thsr_timetable {origin, destination, date?, time?}`: HSR timetables.
- `tra_timetable {origin, destination, date?, time?}`: TRA timetables, train types, cancellations and extra trains.
- `tra_live {train_no?, station?}`: provide exactly one to check train location and delay or a station board.

Stock dates can lag on holidays; company announcements govern dividends.

## Developers

[![Daily live check](https://github.com/ycsmiley/formosa-mcp/actions/workflows/daily-eval.yml/badge.svg)](https://github.com/ycsmiley/formosa-mcp/actions/workflows/daily-eval.yml)

Node.js 20+ is required. Run the npm package directly:

```sh
npx -y formosa-mcp --toolsets=invoice,stock
```

MCP client configuration:

```json
{
  "mcpServers": {
    "formosa": { "command": "npx", "args": ["-y", "formosa-mcp"] }
  }
}
```

From source:

```sh
git clone https://github.com/ycsmiley/formosa-mcp.git
cd formosa-mcp
npm ci && npm run build
node dist/stdio.js --toolsets=invoice,stock
```

From-source configuration (replace the path with your absolute path):

```json
{
  "mcpServers": {
    "formosa": {
      "command": "node",
      "args": ["/absolute/path/formosa-mcp/dist/stdio.js", "--toolsets=invoice,stock"]
    }
  }
}
```

The committed bundle also runs without installing npm packages via `node plugin/server/formosa-mcp.mjs`. Install the Claude Code plugin with `claude plugin marketplace add ycsmiley/formosa-mcp`, then `claude plugin install formosa@formosa-mcp`.

Invoice and stock toolsets are enabled by default; use `--toolsets` to select them or opt into rail, and `--help` for usage. MOF invoice RSS caches for six hours (ten minutes on announcement day when the new draw is pending); TWSE and TPEx stock datasets cache for one hour. Run `npm run build`, `npm test`, `npm run live-check` and `npm run eval:live`; the latter two need network access. See [live evaluations](evals/README.md).

### Railway keys

1. Register as a free member at [TDX](https://tdx.transportdata.tw) and wait for approval. Free membership has monthly API call limits.
2. Get your Client Id and Client Secret under 會員中心 → API 金鑰 (Member Center → API Keys).
3. Add `env` to your Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`) MCP configuration, replacing the placeholders with your own keys:

```json
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp", "--toolsets=invoice,stock,rail"],
      "env": {
        "TDX_CLIENT_ID": "你的 Client Id",
        "TDX_CLIENT_SECRET": "你的 Client Secret"
      }
    }
  }
}
```

4. Save the configuration and restart Claude Desktop or Cursor.

Keep keys in local configuration, never paste them into conversations or commit them; `.env` is gitignored. Enable rail with `--toolsets=invoice,stock,rail` or `--toolsets=rail`. Without a key, rail tools show this setup guide.

Your own key enables local rail queries, including live train delays. Rail was verified against real TDX responses on 2026-10-29. Successful replies credit 資料介接「交通部TDX平臺」; see [TDX fixtures](test/fixtures/tdx/README.md).

### Remote (Cloudflare Workers)

Invoices, stocks, and project-key rail timetables read KV snapshots. TRA live requests use a shared TDX gateway and fall back to scheduled trains when unavailable. Worker cron refreshes TWSE and invoices; the [TPEx collector](.github/workflows/tpex-collect.yml) and [rail collector](.github/workflows/rail-snapshot.yml) write snapshots through GitHub Actions. The [garbage collector](.github/workflows/garbage-collect.yml) collects all three cities at 11:37 Taipei time. Workers Free keeps its 10 ms CPU limit; rail compaction runs in the collector. The limit is 30 requests per IP per minute.

#### Remote rail

- **A: Project key.** Shared timetable snapshots cover today and tomorrow; the GitHub Actions collector fills missing snapshots at 00:23 and 04:23 Taipei time, with station refreshes every seven days. Timetable queries make no TDX calls. Live TRA queries fetch on demand with a shared two-minute cache. Four caps apply: four upstream calls per minute, a daily allowance divided over the remaining days, 4,500 calls per month (live ceiling is 90% minus the snapshot charge: default reserve 300 gives 3,750), and six live cache misses per IP per hour. Caps or upstream failures return scheduled trains with a reason note.
- **B: Bring your own key.** Add these `headers` to the existing remote endpoint entry in Claude Code's `.mcp.json` or Cursor's `.cursor/mcp.json` (merge this fragment with your endpoint configuration):

```json
{
  "mcpServers": {
    "formosa": {
      "headers": {
        "X-TDX-Client-Id": "YOUR_CLIENT_ID",
        "X-TDX-Client-Secret": "YOUR_CLIENT_SECRET"
      }
    }
  }
}
```

Your own key enables other dates and live queries without using project quota. The MCP limit of 30 requests per IP per minute still applies. Keys are used only for that request and are never stored or logged. Keep them in private client settings; never put keys in the URL, paste them into conversations, or commit them. Supply both headers; each trimmed value must contain 1–256 printable ASCII characters.

Full project-key functionality needs `TDX_CLIENT_ID`/`TDX_CLIENT_SECRET` as both repository secrets (collector) and Worker secrets (live queries). The collector also needs repo secret `CLOUDFLARE_KV_WRITE_TOKEN` and repo variable `CLOUDFLARE_ACCOUNT_ID`. Missing TDX repo secrets skip the workflow successfully.

For local rail bootstrap, run `node scripts/dist/publish-rail.mjs --out /tmp/rail --wrangler-bulk /tmp/rail-bulk.json`, then import into local KV; mock setup and complete commands are in the guide below. `npm run build:collectors` rebuilds both collector bundles.

See the [remote rail design](docs/remote-rail.md) for budget formulas, monitoring, maintainer secrets setup, and offline abuse tests.

Local development needs Node.js 22+; the two `kv key put --local` commands write TPEx snapshots only to local KV, leaving production untouched.

```sh
npm run dev:worker
# another terminal
npm run collect:tpex -- --out /tmp/tpex
npx wrangler kv key put --binding SNAPSHOTS --local "stock:quotes:tpex:v1" --path /tmp/tpex/stock_quotes_tpex_v1.json
npx wrangler kv key put --binding SNAPSHOTS --local "stock:dividends:tpex:v1" --path /tmp/tpex/stock_dividends_tpex_v1.json
curl "http://localhost:8787/__scheduled"
npm run remote-check
```

Verify with `npm run typecheck:worker` and `npm run test:worker`. `@modelcontextprotocol/sdk` is pinned exactly to `1.32.1` for `agents`.

## Data sources and licence

- The project code is licensed under [MIT](LICENSE).
- Data is used under the [Open Government Data License, version 1.0 (政府資料開放授權條款第1版)](https://data.gov.tw/license). Sources: Ministry of Finance (e-invoice winning numbers), Taiwan Stock Exchange (TWSE OpenAPI), Taipei Exchange (TPEx OpenAPI), and MOTC TDX (資料介接「交通部TDX平臺」).
- Garbage schedules use [New Taipei](https://data.gov.tw/dataset/125664), [Taipei](https://data.gov.tw/dataset/136515) and [Taichung](https://data.gov.tw/dataset/84004) environmental protection bureaus’ open data (OGDL-1). Taipei weekdays follow the bureau rule. Tainan and Kaohsiung are not yet supported because their open-data sites only accept connections from Taiwan, which the cloud collector cannot reach.
- This is an unofficial project and is not affiliated with those agencies. Data may be delayed or inaccurate; official announcements prevail.
- Stock data is end-of-day, for reference only, and is not investment advice.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
