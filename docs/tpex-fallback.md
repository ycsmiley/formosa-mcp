# TPEx scheduled-run fallback

The Worker checks `stock:collect:tpex:v1` and dispatches Collect TPEx when the heartbeat is missing/invalid or its `dataDate` is not today's Taipei date. Each successful collector run refreshes the heartbeat, even when upstream has no new data. Stock quotes warn of delay only when both the data date and the last successful check predate the expected weekday (today after 18:00 Taipei, otherwise the previous weekday).

Reuses `0,30 * * * MON-FRI` at **11:00/12:30 UTC Mon–Fri = Taipei 19:00/20:30** alongside TWSE; no new cron. Unknown-cron local bootstrap never dispatches. Failures do not affect TWSE.

At most two attempts per Taipei date: `tpex:fallback:YYYY-MM-DD` stores a string count with TTL **259200 seconds (3 days)**, incremented before dispatch, including failed requests. Missing/empty tokens skip without writing the count.

Set the Worker secret interactively with `npx wrangler secret put GH_DISPATCH_TOKEN`. Use a fine-grained PAT restricted to **ycsmiley/formosa-mcp**, **Actions: read and write**. Never commit or log the token.

Logs (no credentials or response bodies):
- `tpex fallback fresh`
- `tpex fallback skip no token`
- `tpex fallback skip cap`
- `tpex fallback dispatch status=204` (other statuses warn)
- `tpex fallback fail TypeError` (error name only, or `error` for non-Errors)

## Live stale-heartbeat test

1. Save the current heartbeat: `npx wrangler kv key get --binding SNAPSHOTS --remote stock:collect:tpex:v1`.
2. Put a stale copy with an old `dataDate`: `npx wrangler kv key put --binding SNAPSHOTS --remote stock:collect:tpex:v1 --path /path/to/stale-heartbeat.json`.
3. Wait for the next Taipei weekday 19:00/20:30 run. Observe `tpex fallback dispatch status=204` in `npx wrangler tail` and a new `workflow_dispatch` run of **Collect TPEx**.
4. The successful collector rewrites the heartbeat. Restore the saved value only if the run failed.
5. To reset the cap: `npx wrangler kv key delete --binding SNAPSHOTS --remote tpex:fallback:YYYY-MM-DD` (use the Taipei date).

`wrangler dev --test-scheduled` uses local KV only; it does not exercise the remote heartbeat or cap.
