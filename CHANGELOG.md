# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed

- Tainan and Kaohsiung were delisted from `garbage_schedule` because the Actions collector cannot reach their data sites; queries now return a 「目前尚未支援」 explanation. Legacy KV index entries for these cities are ignored.

### Added

- Optional `disaster` toolset (not deployed; off by default everywhere; stdio requires `--toolsets`, Worker and GHA require `DISASTER_ENABLED` exactly lowercase `true`): `work_school_closure` quotes DGPA official statements and `disaster_alerts` formats active NCDR JSON/Atom alerts with authoritative CAP details. Separate official-update/fetch times, successful fetches under 90 minutes old (DGPA page age also uses 90 minutes; NCDR feed updated may be up to 24 hours old), withheld stale “照常” statements, city/county ambiguity handling and anonymous-login-wall reporting. Worker keeps main's four configured crons; explicitly adding the opt-in disaster cron (`5,15,25,35,45,55 * * * *`) uses the fifth and final account-wide Free-plan slot, limiting NCDR request starts to 60 seconds and four CAPs. When enabled via the repository variable, hourly GHA at `20 * * * *` skips sources when valid Worker success is strictly less than 25 minutes old, uses a x4:30–x7:00 quiet window on delayed starts, and fetches up to 20 CAPs. All NCDR requests wait ≥3.1 seconds after the preceding response. Independent writer indexes (`disaster:index:{worker|gha}:v1`), immutable sha12 shards, eight-day TTL/three-day renewal, index-last publication and failure retention. Unchanged healthy collection normally costs 24 Worker index heartbeats/day with zero GHA writes after its initial skip transition; persisted buckets bound scheduled disaster writes to 81 Worker + 42 GHA per 24 hours under the documented serialization/persistence assumptions. Cloudflare egress reachability remains untested until deploy; hourly GHA provides fallback. Local `collect:disaster`/`FORMOSA_DISASTER_DIR` or ten-minute live success cache (six CAPs). No new keys/secrets; Claude plugin selection remains `invoice,stock`.

- p35-fix1: prevent false absence claims for summary-only or stale disaster data; infer counties from unambiguous district names, show county-specific CAP areas (200 stored/15 displayed), rotate CAP budgets, and isolate local source refreshes with 12-second request timeouts and a two-minute failure cache retaining older good data.

- p35-r1fix2: correct NCDR quiet-period freshness (successful fetch under 90 minutes; feed updated at most 24 hours old), preserve DGPA's 90-minute page rule, and map CAP Taiwan_Geocode_103 prefixes to county-specific earthquake areas. Recompile summary matching once per isolate, skip retained CAP county matching, anchor Worker request deadlines/guard to scheduledTime, surface corrupt indexes, add 花蓮市/馬祖 and disaster eval coverage. Garbage preserves unchanged city generations, repairs missing/corrupt shards, renews after seven days and only then updates its index; changed districts rewrite their city. Typical unchanged scheduled KV total becomes 47–49/day; the all-change/renewal envelope remains 703/day.

- p35-r1fix: require source-specific freshness and fresh fetch times, successful latest attempts, dual JSON/Atom verified emptiness and complete CAP geography before alert-absence claims; show upcoming alerts, propagate CAP login walls, reject regressing source revisions, tighten GHA skips, sanitize/cap responses and resolve unique township inputs. Both disaster writers use 55-minute heartbeats and persisted token buckets (81/42 writes per 24h, DGPA priority); audit all scheduled KV writers in docs/kv-budget.md (703/day conservative envelope; a separate rail call cap would yield 699).


- Planned water/power outages (`outage_schedule`, default `outage` toolset) from Taiwan Water, Taipei Water and Taipower (OGDL-1). Actions collects at 06:23/12:23/18:23 Asia/Taipei (`23 22,4,10 * * *`), writes immutable `outage:v1:{source}:{county}:{sha12}` KV shards (first 12 SHA-256 hex characters, 8-day TTL), then `outage:index:v1` as the run heartbeat; county entries record `writtenAt`, unchanged shards renew only after 3 days, and failed sources retain previous county entries and last success. Worker reads KV only; local stdio supports `FORMOSA_OUTAGE_DIR` or a 12-hour success cache, retrying failures immediately. Empty Taiwan Water exports are unavailable, unknown times stay visible, and notices older than 24 hours share one warning. Output filters windows to the query, compresses consecutive daily hours, removes repeated area prefixes and uses an explicit fallback for missing/area-only Taipei Water reasons.
- Empty Taiwan Water exports retain and display previous notices with an incomplete-data warning and the official lookup link; successful exports restore normal results automatically.

- Garbage collection schedules (`garbage_schedule`, toolset `garbage`) for New Taipei, Taipei and Taichung: GitHub Actions collects all cities at 11:37 Taipei time, writing per-district KV shards (`garbage:v2:${city}:${gen}:${district}`, 14-day TTL, index `garbage:index:v2` last); the Worker reads KV only and local stdio fetches live with a 12-hour cache.
- Remote rail: project-key KV timetables, GitHub Actions snapshot collection, shared live cache and quota gateway with timetable fallback; optional per-request TDX key headers.
- Dependency-free offline TDX mock and rail abuse harness, manual multi-runner abuse workflow with optional KV usage comparison, and bilingual remote rail documentation.
- Rail (opt-in `--toolsets rail`, own TDX key): verified against real TDX responses (2026-10-29); a friendly Traditional Chinese setup guide replaces an error when `TDX_CLIENT_ID` or `TDX_CLIENT_SECRET` is missing, without network calls.
- Remote Worker: strict per-IP rate limit (30 requests / 60 s, 429 with Retry-After) using a Durable Object fixed-window counter; IPv6 grouped by /64, IPv4-mapped IPv6 mapped to IPv4.
- README split into `README.md` (繁體中文) and `README.en.md` (English), badges, data sources and licence section; CI workflow; `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md`.

### Changed

- Move rail station/timetable fetching and TRA compaction from Worker cron to a bundled GitHub Actions collector, preserving Workers Free; add local directory/bulk export, paced lazy token calls, monthly usage reporting and a default 300-call snapshot reserve (3,750 live ceiling at quota 4,500).
- TRA station live board sorted by scheduled time, including across midnight.
- Remote rail developer guides document project-key and bring-your-own-key modes; local rail remains opt-in.

## [0.1.0] - 2026-10-29

### Added

- Invoice toolset (財政部 RSS, no key): `invoice_get_winning_numbers`, `invoice_check` (3–8 digits, claim periods, draw-day short cache).
- Stock toolset (TWSE + TPEx OpenAPI, no key): `stock_quote` (close, change, volume, P/E, yield, P/B; name search) and `stock_dividends`; end-of-day data with data dates.
- `--toolsets` selection (invoice, stock by default) and `--help`; stdio entry `formosa-mcp`.
- Rail toolset preview (opt-in, needs own TDX key): `thsr_timetable`, `tra_timetable`, `tra_live`.
- Library exports (`formosa-mcp` core, `formosa-mcp/mcp`).
- Claude Code plugin and Agent Skill with a committed bundled server.
- Cloudflare Workers remote server (reads KV snapshots only; cron refresh for TWSE/invoice; TPEx snapshots via GitHub Actions), not yet publicly announced.
- Daily live evaluation set (30 Taiwan questions) and workflow; listing metadata (`server.json`, `glama.json`, `lhm.plugin.json`), Dockerfile.
- npm package limited to dist; no install scripts.

<!-- Tag v0.1.0 is not created yet. -->
[Unreleased]: https://github.com/ycsmiley/formosa-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ycsmiley/formosa-mcp/releases/tag/v0.1.0
