# 遠端鐵路 / Remote rail

The Worker exposes rail alongside invoices and stocks. Project credentials belong to a single `TdxGateway` Durable Object named `tdx`. Timetable requests read compact KV snapshots; live TRA requests pass through the gateway. When live data is unavailable, replies show the reason, scheduled trains when available, and the snapshot update time. Fallback is a normal tool reply, without `isError`.

Clients may instead send both `X-TDX-Client-Id` and `X-TDX-Client-Secret`. The Worker removes these headers before MCP transport handling and creates a rail service for that request only. User keys and tokens are not stored or logged, do not share project token/cache/budget state, and do not consume project quota. The per-IP MCP limit still applies. Never put keys in URLs or commit client settings containing keys. Invalid or incomplete header pairs return a setup hint. Each trimmed value must be 1–256 printable ASCII characters.

## Storage and collection

Workers Free stays at 10 ms CPU per invocation. Rail snapshot fetching and TRA compaction run in the [GitHub Actions collector](../.github/workflows/rail-snapshot.yml), using the committed `scripts/dist/publish-rail.mjs` bundle. Worker cron handles invoices and TWSE only.

| KV key | Contents / lifetime |
| --- | --- |
| `rail:stations:THSR:v1` / `rail:stations:TRA:v1` | Compact `[id, zh, en]` station rows; refreshed when missing or older than seven days, no expiry |
| `rail:timetable:THSR:YYYY-MM-DD:v1` / `rail:timetable:TRA:YYYY-MM-DD:v1` | Compact train metadata and ordered stops; three-day TTL, publicly queried only for today/tomorrow |
| `tdx:snapshot-usage:YYYY-MM` | Collector usage for the Taipei month: `{v:1, month, days:{'YYYY-MM-DD':n}, total, updatedAt}`; 62-day TTL |
| `tdx:usage:v1` | Credential-free gateway observation: month/today totals, token/live counts, reserve, collector report, budgets, recent calls, update time |

The collector runs at **00:23 and 04:23 Asia/Taipei** (`23 16,20 * * *` UTC), or via `workflow_dispatch`. It fills missing today/tomorrow timetable keys and skips existing ones. The second run retries incomplete work; a steady-state run with all keys present makes **zero TDX calls**, including token calls. Work is ordered today THSR, today TRA, stations THSR/TRA, tomorrow THSR, tomorrow TRA. A small call budget can therefore publish today's timetable before stations are available; the Worker gives its existing missing-station hint until both are present.

THSR uses one full-day v2 timetable call per date. TRA uses the v3 full-day timetable, `$top=1000`, up to three pages with `$skip`, marking a capped result as potentially incomplete. Station refreshes use THSR v2 and TRA v3. The token is fetched lazily and refreshed once after a data 401. Every attempted TDX request counts, including tokens and failures. Consecutive calls are spaced at least **15 seconds** apart (at most four per minute); `--max-calls N` can impose a smaller run budget. Failed keys do not prevent other keys from being written; any fetch/put failure exits 1. Budget exhaustion warns/skips and exits 0 unless a separate failure occurred.

An empty-cache bootstrap uses **7–11 calls per run** (one token, two stations, two THSR dates, and two TRA dates at 1–3 pages each). After midnight, yesterday's tomorrow is already today's snapshot: the usual first run needs **3–5 calls**, plus about two station calls per week; the second needs zero if collection succeeded. At one or two TRA pages, expect about **3.3–4.3 calls/day, roughly 100–135/month**, before bootstrap/retries. Three-page TRA days approach 165/month. The collector refuses further calls once its monthly count would exceed `TDX_SNAPSHOT_RESERVE` (default **200**, integer clamped to 0–`TDX_MONTHLY_QUOTA`). Each run reads the usage key and persists each attempted call before requesting TDX; a failed usage write stops further calls. Workflow concurrency prevents overlapping collector read-modify-write runs; run manual collectors sequentially against the same store.

`FixedWindowCounter` enforces the MCP limit before routing: 30 requests per IP per fixed 60-second window, HTTP 429 with `Retry-After`. IPv6 clients share a /64; mapped IPv4 normalizes to IPv4. IP keys hash across 16 DO shards. These counters are in memory.

`TdxGateway` serializes live admissions and persists daily token/live counts, recent call timestamps, IP misses, and the project token in SQLite. Successful live results are shared for **120 seconds**, concurrent requests for the same path coalesce, and at most 256 live cache entries are retained. Cache hits consume no TDX quota or IP miss allowance. Project tokens are reused until shortly before expiry. The Worker makes no snapshot calls.

## Caps and formulas

Let `Q` be the monthly quota (default 4,500), `M` and `D` be DO-counted token/live use this month and today, `C` be the collector's reported month total (zero if unknown), and `R` be Taipei calendar days remaining **including today**:

```text
snapshotCharge = max(snapshotReserve, C)
liveCeiling = max(0, floor(0.9 × Q) − snapshotCharge)
usedBeforeToday = M − D
dailyBudget = max(0, floor((liveCeiling − usedBeforeToday) / R))
n = 1 data call + (1 if a fresh token is needed, otherwise 0)
```

At **Q = 4,500**, a reserve of **200** gives `liveCeiling = 4,050 − 200 = 3,850`. A collector report of 130 leaves 3,850; a report of 250 lowers it to 3,800. With 2,000 calls used before today and 11 days remaining, the daily budget is `floor((3,850 − 2,000) / 11) = 168`. At Q = 20 and reserve = 2, the live ceiling is 16. The reserve is clamped to Q in both the collector and gateway. Their independent pacing can briefly exceed the project’s 4/min safety guard during collection (not a TDX limit); coordination would require a new authenticated Worker endpoint.

| Cap | Admission rule |
| --- | --- |
| Minute | DO calls in the sliding last 60 seconds + `n` ≤ 4, counting token and live calls |
| Daily | `D + n ≤ dailyBudget` |
| Monthly | `M + n ≤ liveCeiling` |
| IP | At most six admitted live cache misses per IP in a sliding hour; a token is not an additional IP miss |

The collector has its own pacing and monthly self-limit; the gateway observes its KV month total outside serialized admission, memoized for five minutes per month. Both successful and failed attempts count. Cap denials, missing credentials and upstream failures degrade live queries to scheduled trains with a reason note. The independent MCP HTTP limit can return 429. `TDX_MONTHLY_QUOTA` accepts integers 1–4,500 to lower the project budget; invalid values use 4,500. `TDX_BASE_URL` accepts only HTTP origins at localhost or 127.0.0.1, otherwise the production TDX origin is used.

## Monitoring and deployment setup

`tdx:usage:v1` includes `month`, `monthUsed`, `monthlyQuota`, `snapshotReserve`, `snapshotReported`, `liveCeiling`, `pct`, `today`, `todayUsed`, `dailyBudget`, `byPurpose` (`token`, `live`), `last60s`, and `updatedAt`. `monthUsed`/`pct` describe DO calls; collector calls are reported separately. Gateway publications coalesce to at most once per 15 minutes when usage changes. KV propagation and memoization add delay; `last60s` describes the observation time. Read `tdx:snapshot-usage:YYYY-MM` for collector totals and daily counts.

Configure these repository settings for the workflow:

- Secrets: `TDX_CLIENT_ID`, `TDX_CLIENT_SECRET`, and `CLOUDFLARE_KV_WRITE_TOKEN` with KV write/read access to the configured namespace.
- Variables: `CLOUDFLARE_ACCOUNT_ID`, plus optional `TDX_SNAPSHOT_RESERVE` and `TDX_MONTHLY_QUOTA` (empty values use defaults). The workflow hard-codes the same `KV_NAMESPACE_ID` as `wrangler.jsonc`.

Absent TDX secrets make the workflow succeed with `::notice::rail snapshot skipped: TDX_CLIENT_ID/TDX_CLIENT_SECRET not set`. The standalone collector trims credentials and has the same skip behaviour before touching TDX or KV. Missing Cloudflare configuration in KV mode prints variable names and exits 2. Logs show key summaries and `rail collector calls=N elapsedMs=… bytes=…`; they exclude credentials, tokens and response bodies. In Actions, received tokens are immediately registered with `::add-mask::`.

Full project-key functionality needs **both repository secrets for the collector and Worker secrets for live requests**. The maintainer configures Worker secrets interactively:

```sh
wrangler secret put TDX_CLIENT_ID
wrangler secret put TDX_CLIENT_SECRET
```

Deploy with the KV binding and SQLite DO migrations in `wrangler.jsonc`, then run the rail workflow to populate snapshots. Existing snapshots remain readable without Worker TDX secrets. If changed, the Worker vars and repository variables `TDX_SNAPSHOT_RESERVE` and `TDX_MONTHLY_QUOTA` must match (defaults 200 and 4,500 respectively). This task does not set secrets or deploy.

## Local collector

Build both committed bundles with `npm run build:collectors` (`npm run build:tpex` still builds TPEx). For a local directory, Cloudflare configuration is unnecessary:

```sh
TDX_CLIENT_ID=local-fake-id TDX_CLIENT_SECRET=local-fake-secret \
  TDX_BASE_URL=http://127.0.0.1:8790 \
  node scripts/dist/publish-rail.mjs --out /tmp/rail --interval-ms 0 \
  --wrangler-bulk /tmp/rail-bulk.json
```

This command requires the offline mock below. Directory mode reads previous values from the same directory and writes each key with colons replaced by underscores as `.json`, plus `.meta.json` containing `{fetchedAt, dataDate}`. `--wrangler-bulk` requires `--out` and exports only written keys as `{key,value,expiration_ttl?}`. To collect from real TDX locally, omit the loopback override and use private TDX credentials; keep the default 15-second interval.

## Offline local abuse run

Use Node.js 22+ and the installed Wrangler. All credentials below are fake; keep the loopback override on every local run. The mock uses `test/fixtures/tdx/real` as templates, refreshes timestamps/service dates, converts THSR OD rows to day-timetable stops, and adds synthetic station IDs for missing names. It binds only to loopback, records `{t, kind}` for every request, drains request bodies without logging them, and serves statistics at `/__stats`. It is never a production upstream.

Terminal 1:

```sh
node scripts/mock-tdx.mjs
```

Terminal 2 (disable Wrangler telemetry and use local bindings):

```sh
WRANGLER_SEND_METRICS=false npx --no-install wrangler dev --local --test-scheduled \
  --var TDX_BASE_URL:http://127.0.0.1:8790 \
  --var TDX_CLIENT_ID:local-fake-id \
  --var TDX_CLIENT_SECRET:local-fake-secret \
  --var TDX_MONTHLY_QUOTA:4500
```

Terminal 3: bootstrap rail snapshots against the mock and seed **local** KV before running the harness. Collector compaction runs in Node, outside the Worker:

```sh
TDX_CLIENT_ID=local-fake-id TDX_CLIENT_SECRET=local-fake-secret \
  TDX_BASE_URL=http://127.0.0.1:8790 \
  node scripts/dist/publish-rail.mjs --out /tmp/rail --interval-ms 0 \
  --wrangler-bulk /tmp/rail-bulk.json
WRANGLER_SEND_METRICS=false npx --no-install wrangler kv bulk put /tmp/rail-bulk.json \
  --binding SNAPSHOTS --local
# Restart the mock to clear the unpaced bootstrap statistics before checking live pacing.
node scripts/abuse-test.mjs --url http://127.0.0.1:8787/mcp \
  --requests 120 --concurrency 8 --label local-rotate --fake-ip --ips 20 \
  --mock-stats http://127.0.0.1:8790/__stats --out /tmp/rail-abuse.json
```

Alternatively keep the collector's default interval and wait at least 60 seconds after bootstrap before starting load; combined statistics then retain the four-per-minute check. Reuse the same Wrangler persistence directory for bulk put and dev (pass matching `--persist-to` when customized).

For a single-IP run, omit `--fake-ip`; 429 responses after the MCP allowance are expected. Cloudflare **overwrites `CF-Connecting-IP` in production**, so synthetic headers only simulate multiple IPs against local Wrangler. Restarting the mock clears its statistics; restarting Wrangler does not clear persisted DO counters/tokens. For a fresh bootstrap, use a new `--persist-to /tmp/rail-abuse-state` directory on Wrangler. Statistics cover the mock's whole lifetime, including collector bootstrap, and exclude `/__stats` requests from upstream totals.

`npm run abuse-test -- --help` lists the options. `--url` is required unless `URL` is set; `REQUESTS`, `CONCURRENCY`, `LABEL`, `FAKE_IP=1`, `IPS`, `MOCK_STATS` and `OUT` are environment equivalents. CLI values take precedence. Defaults are 120 requests, concurrency 8 and 20 simulated IPs. The request mix rotates twenty TRA station names and four train numbers, plus today's TRA 臺北→高雄 and THSR 臺北→左營 timetables. It sends stateless `tools/call` JSON-RPC and accepts JSON or SSE `data:` replies.

The JSON summary includes elapsed milliseconds, HTTP status counts, `isError` counts, fallbacks by reason note, live age-line successes, timetable tool replies (including unavailable-snapshot hints), raw JSON/`undefined` leaks and 5xx counts. Optional mock stats report total upstream calls, token calls, and the maximum number in any sliding 60-second window. Exit status is 1 for any 5xx, leak, HTTP-200 `tra_live` tool error, or mock maximum above four; transport failures and malformed JSON-RPC replies also fail. HTTP 429 alone is expected and does not fail the run.

## Manual deployed workflow

Run [abuse-test.yml](../.github/workflows/abuse-test.yml) via `workflow_dispatch` **only after deployment**. Supply the deployed `/mcp` endpoint, requests (120), concurrency (8), and 1/3/5 runners (3). `hammer` sends requests ×3 from one runner/IP; `rotate` then sends the requested load on each separate runner, providing different egress IPs. No dependencies are installed. Inputs enter shell commands through environment variables. The workflow consumes project TDX quota on cache misses, bounded by the caps.

Optional monitoring requires secrets `CLOUDFLARE_API_TOKEN` (KV read access), `CLOUDFLARE_ACCOUNT_ID`, and repo variable or secret `SNAPSHOTS_KV_ID`. Without all three, usage reads and the final job skip cleanly; load jobs still run. The first job reads `tdx:usage:v1` using the Cloudflare REST API, and the final job reads it again, prints deltas for `monthUsed`, `todayUsed`, and `last60s`, and fails if `todayUsed > dailyBudget` or `last60s > 4`. Day/month rollover produces a null delta for the reset counter. A configured monitor needs an existing usage key. Because KV observations can lag, these deltas are approximate and do not certify a short burst's exact upstream count. This workflow has not been dispatched as part of this offline task.
