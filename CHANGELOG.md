# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Garbage collection schedules (`garbage_schedule`, toolset `garbage`) for New Taipei, Taipei, Taichung, Tainan and Kaohsiung: GitHub Actions collects all cities at 11:37 and Kaohsiung only at 05:00 Taipei time, writing per-district KV shards (`garbage:v2:${city}:${gen}:${district}`, 14-day TTL, index `garbage:index:v2` last); the Worker reads KV only and local stdio fetches live with a 12-hour cache.
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
