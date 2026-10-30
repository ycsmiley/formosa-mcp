# 遠端鐵路 / Remote rail

The Worker exposes rail alongside invoices and stocks. Project credentials belong to a single `TdxGateway` Durable Object named `tdx`. Timetable requests read compact KV snapshots; live TRA requests pass through the gateway. When live data is unavailable, replies show the reason, scheduled trains when available, and the snapshot update time. Fallback is a normal tool reply, without `isError`.

Clients may instead send both `X-TDX-Client-Id` and `X-TDX-Client-Secret`. The Worker removes these headers before MCP transport handling and creates a rail service for that request only. User keys and tokens are not stored or logged, do not share project token/cache/budget state, and do not consume project quota. The per-IP MCP limit still applies. Never put keys in URLs or commit client settings containing keys. Invalid or incomplete header pairs return a setup hint. Each trimmed value must be 1–256 printable ASCII characters.

## Storage and refresh

| KV key | Contents / lifetime |
| --- | --- |
| `rail:stations:THSR:v1` / `rail:stations:TRA:v1` | Compact `[id, zh, en]` station rows; refreshed after seven days, no expiry |
| `rail:timetable:THSR:YYYY-MM-DD:v1` / `rail:timetable:TRA:YYYY-MM-DD:v1` | Compact train metadata and ordered stops; three-day TTL, publicly queried only for today/tomorrow |
| `tdx:usage:v1` | Credential-free quota observation: month/today totals, purpose counts, budgets, recent calls, update time |

Snapshots have a version, service date, fetch timestamp, and truncation flag. Cron `23 16,20 * * *` UTC runs at **00:23 and 04:23 Asia/Taipei**. It fills missing today/tomorrow timetable keys; existing keys are skipped, so the second cron retries incomplete work. The first pass after midnight usually fetches only the new tomorrow. THSR uses one full-day v2 timetable call per date. TRA uses the v3 full-day timetable, `$top=1000`, up to three pages with `$skip`, and marks a capped result as potentially incomplete. Station refreshes use two endpoints, THSR v2 and TRA v3. Snapshot admission retries a minute cap up to three times with bounded waits.

`FixedWindowCounter` enforces the MCP limit before routing: 30 requests per IP per fixed 60-second window, HTTP 429 with `Retry-After`. IPv6 clients share a /64; mapped IPv4 normalizes to IPv4. IP keys hash across 16 DO shards. These counters are in memory.

`TdxGateway` serializes project admissions, persists daily counts, recent call timestamps and the project token in SQLite, and counts token exchanges as upstream calls. It shares successful live results for **120 seconds**, coalesces concurrent requests for the same path, and retains at most 256 live cache entries. Cache hits do not consume TDX quota or the IP miss allowance. Per-IP live miss timestamps are held in DO memory for one hour. The project token is reused until shortly before expiry; snapshot data fetches run in the cron after a gateway admission.

## Caps and formulas

Let `Q` be the monthly quota (default 4,500), `M` monthUsed, `D` todayUsed, and `R` the number of days remaining in the Taipei calendar month **including today**:

```text
liveCeiling = floor(0.9 × Q)
usedBeforeToday = M − D
dailyBudget = max(0, floor((liveCeiling − usedBeforeToday) / R))
n = 1 data call + (1 if a fresh token is needed, otherwise 0)
```

| Cap | Admission rule |
| --- | --- |
| Minute | Existing calls in the sliding last 60 seconds + `n` ≤ 4, including token and snapshot calls |
| Daily | Live: `D + n ≤ dailyBudget`; snapshot: today's token + snapshot calls + `n` ≤ 20 |
| Monthly | Live: `M + n ≤ liveCeiling`; snapshot: `M + n ≤ Q`, reserving the last 10% for snapshots |
| IP | At most six admitted live cache misses per IP in a sliding hour; token calls count in global budgets, not as an additional IP miss |

Both successful and failed upstream attempts consume reservations. Missing credentials, cap denials and TDX failures degrade live queries to a timetable with a reason note such as `目前查詢人數較多（每分鐘上限）`. The independent MCP HTTP limit can still return 429. `TDX_MONTHLY_QUOTA` accepts an integer 1–4,500 and can lower the budget for local demonstrations; invalid values use 4,500. `TDX_BASE_URL` accepts only HTTP origins at localhost or 127.0.0.1; other values fall back to the production TDX origin.

For timetable snapshots in steady state, expect **token ≤1 + THSR 1 + TRA 1–2 + stations 2/7 ≈ 3–4.3 calls/day, approximately ≤130/month**. This assumes one or two TRA pages and no failures; a third page or retries increase the count. Empty-cache bootstrap needs approximately **8 calls** (one token, two station lists, two THSR dates, and two TRA dates with one requiring another page). Fixture bootstrap with single-page TRA responses uses seven. Live cache misses add calls within the caps; cache hits add none.

## Monitoring and deployment setup

Read KV key `tdx:usage:v1` for `month`, `monthUsed`, `monthlyQuota`, `liveCeiling`, `pct`, `today`, `todayUsed`, `dailyBudget`, `byPurpose` (`token`, `live`, `snapshot`, month totals), `last60s` and `updatedAt`. DO publications are coalesced to at most once per 15 minutes when totals change; cron also publishes a usage record after refresh. KV propagation adds delay. `last60s` describes the record's timestamp, not necessarily the current minute. Use mock statistics for exact local verification.

Cron logs `tdx usage {...}` and warns `tdx usage at least 70%` at that threshold. Other relevant lines include `rail snapshot skipped: no project TDX key`, `rail snapshot skipped: ... unavailable`, `tdx token authentication failed` and `tdx usage unavailable`. Logs contain no keys or request bodies.

The **maintainer must run** these commands interactively before project-key rail is enabled; this task has **not** set any secrets:

```sh
wrangler secret put TDX_CLIENT_ID
wrangler secret put TDX_CLIENT_SECRET
```

Deploy the Worker with the KV binding and both SQLite DO migrations in `wrangler.jsonc`, then let rail cron populate snapshots. Existing snapshots remain readable without project keys. This guide does not publish a remote endpoint.

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

Terminal 3: trigger **only the rail cron** to avoid invoice/stock upstream requests. Wait for refresh to finish; bootstrap spans multiple minute windows because token and snapshot calls share the four-call cap.

```sh
curl --get 'http://127.0.0.1:8787/__scheduled' --data-urlencode 'cron=23 16,20 * * *'
node scripts/abuse-test.mjs --url http://127.0.0.1:8787/mcp \
  --requests 120 --concurrency 8 --label local-rotate --fake-ip --ips 20 \
  --mock-stats http://127.0.0.1:8790/__stats --out /tmp/rail-abuse.json
```

For a single-IP run, omit `--fake-ip`; 429 responses after the MCP allowance are expected. Cloudflare **overwrites `CF-Connecting-IP` in production**, so synthetic headers only simulate multiple IPs against local Wrangler. Restarting the mock clears its statistics; restarting Wrangler does not clear persisted DO counters/tokens. For a fresh bootstrap, use a new `--persist-to /tmp/rail-abuse-state` directory on Wrangler. Statistics cover the mock's whole lifetime, including cron bootstrap, and exclude `/__stats` requests from upstream totals.

`npm run abuse-test -- --help` lists the options. `--url` is required unless `URL` is set; `REQUESTS`, `CONCURRENCY`, `LABEL`, `FAKE_IP=1`, `IPS`, `MOCK_STATS` and `OUT` are environment equivalents. CLI values take precedence. Defaults are 120 requests, concurrency 8 and 20 simulated IPs. The request mix rotates twenty TRA station names and four train numbers, plus today's TRA 臺北→高雄 and THSR 臺北→左營 timetables. It sends stateless `tools/call` JSON-RPC and accepts JSON or SSE `data:` replies.

The JSON summary includes elapsed milliseconds, HTTP status counts, `isError` counts, fallbacks by reason note, live age-line successes, timetable tool replies (including unavailable-snapshot hints), raw JSON/`undefined` leaks and 5xx counts. Optional mock stats report total upstream calls, token calls, and the maximum number in any sliding 60-second window. Exit status is 1 for any 5xx, leak, HTTP-200 `tra_live` tool error, or mock maximum above four; transport failures and malformed JSON-RPC replies also fail. HTTP 429 alone is expected and does not fail the run.

## Manual deployed workflow

Run [abuse-test.yml](../.github/workflows/abuse-test.yml) via `workflow_dispatch` **only after deployment**. Supply the deployed `/mcp` endpoint, requests (120), concurrency (8), and 1/3/5 runners (3). `hammer` sends requests ×3 from one runner/IP; `rotate` then sends the requested load on each separate runner, providing different egress IPs. No dependencies are installed. Inputs enter shell commands through environment variables. The workflow consumes project TDX quota on cache misses, bounded by the caps.

Optional monitoring requires secrets `CLOUDFLARE_API_TOKEN` (KV read access), `CLOUDFLARE_ACCOUNT_ID`, and repo variable or secret `SNAPSHOTS_KV_ID`. Without all three, usage reads and the final job skip cleanly; load jobs still run. The first job reads `tdx:usage:v1` using the Cloudflare REST API, and the final job reads it again, prints deltas for `monthUsed`, `todayUsed`, and `last60s`, and fails if `todayUsed > dailyBudget + 20` or `last60s > 4`. Day/month rollover produces a null delta for the reset counter. A configured monitor needs an existing usage key. Because KV observations can lag, these deltas are approximate and do not certify a short burst's exact upstream count. This workflow has not been dispatched as part of this offline task.
