# Fleet-liveness outage drill

Rehearsal and execution runbook for the token-free fleet-liveness heartbeat — the dead-man's switch that pages `#fleet-outages` when the Claude fleet stops answering.

The drill simulates a total fleet outage and verifies the whole detection path fires end-to-end in under 10 minutes: Cloudflare Worker cron → Slack page in `#fleet-outages` → `fleet.silence_detected` `repository_dispatch` receipt in GitHub Actions.

Parent bet: [Token-free fleet-liveness heartbeat](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/ec861955-00c0-447e-a72e-1b940a61ec0f).
Architecture: [Architecture proposal — pick substrate + alert transport](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/8e54a307-3a2f-493a-ae98-fff8123fce4b).

## When to run

- **Active-hours window only.** Run between **07:00 and 23:00 Europe/Copenhagen** (DST-aware — the same window the worker enforces). Outside that window the worker deliberately does not page, so a drill will register as a miss even though the system is working correctly. Do not rehearse at 23:30 and report it as a failure.
- Budget 20–30 minutes end-to-end. The detection loop is ≤10 minutes by design; the rest is prep and restore.
- Coordinate with anyone on-call for `#fleet-outages` before starting — the page is real and will look real.

## Prerequisites

1. The four Cloudflare Workers secrets are provisioned on the deployed worker: `HEARTBEAT_URL`, `HEARTBEAT_SHARED_SECRET`, `SLACK_WEBHOOK_URL`, `GH_DISPATCH_TOKEN`. See `packages/liveness-worker/README.md` for the `wrangler secret put` commands.
2. The `SILENCE_STATE` Workers KV namespace is bound and its id is in `packages/liveness-worker/wrangler.toml`.
3. The liveness worker is deployed (`pnpm --filter @maskin/liveness-worker deploy`) and its cron trigger `*/2 * * * *` is running against the fresh Cloudflare account.
4. The Slack channel `#fleet-outages` exists in the workspace and the incoming webhook posts to it.
5. The GitHub Actions receiver workflow `.github/workflows/fleet-silence-detected.yml` is on `main` (sibling task T3-workflow). Without it the `repository_dispatch` will still fire, but there will be no visible receipt in the Actions tab.
6. You have shell access to the `app` deployment to change env vars and restart the service.

## How to simulate silence

Pick **one** of the two methods. Method A is the default because it is fast, deterministic, and does not affect network policy.

### A. Invalidate the Claude token (primary)

1. On the `app` deployment, set the env var `CLAUDE_OAUTH_TOKEN=deadbeef` (any non-working value works — the point is that scheduled agent sessions can no longer complete).
2. Restart the `app` service so the new env var is picked up.
3. Record the wall-clock time you did this as timestamp **(a) egress blocked / token invalidated**.
4. Do NOT commit the change. Keep it as an env override on the running deployment.

### B. Block egress to Anthropic (alternative)

1. Apply a firewall rule on the `app` host or its egress network that drops outbound traffic to `api.anthropic.com`.
2. Record the wall-clock time as timestamp **(a)**.
3. Use this variant if you also want to confirm the worker classifies a 5xx or unreachable heartbeat as silence, not only a stale one.

## What to expect (within 10 minutes)

1. Scheduled agent sessions on `app` stop completing (they need the Claude route).
2. Every 2 minutes the deployed worker fetches `GET /api/internal/fleet-heartbeat` on `app` and reads `minutes_since` from the response.
3. When `minutes_since > 8` (and the current time is inside `07:00–23:00 Europe/Copenhagen`), the worker classifies the tick as silent. Record the first heartbeat where you can confirm `minutes_since > 8` as timestamp **(b) first heartbeat that shows `minutes_since > 8`**.
4. On that same tick the worker POSTs the Slack webhook. A message lands in `#fleet-outages` naming the silence duration, the last-heartbeat timestamp, and a link back to the bet. Record the Slack message timestamp as **(c) Slack message received**.
5. The worker also POSTs `POST /repos/sindre-ai/maskin/dispatches` with `event_type: fleet.silence_detected` and body `client_payload: { latest_completed_at, minutes_since, source: "liveness-worker", detected_at }`. A run of the `fleet-silence-detected.yml` workflow appears in the Actions tab of `sindre-ai/maskin`. Record when the dispatch is visible as **(d) `fleet.silence_detected` dispatch visible in GH Actions**.
6. Worker KV dedup means only the FIRST silent tick pages. Subsequent silent ticks log but do not re-page — this is expected.

Target: (c) − (a) ≤ 10 minutes. This is the bet's MTTD acceptance line.

## How to restore

1. Undo the change from the "simulate silence" step: unset `CLAUDE_OAUTH_TOKEN=deadbeef` (or lift the egress firewall rule) and restart `app`. Record the wall-clock time as **(e) restore action taken**.
2. Scheduled agent sessions resume completing.
3. Within roughly 2 minutes the next `/api/internal/fleet-heartbeat` tick returns a fresh `latest_completed_at` and `minutes_since ≤ 8`. The worker clears the KV `silence_active` flag on that first healthy tick. Record when you observe the silence auto-clear (worker log line `silence cleared` via `pnpm --filter @maskin/liveness-worker tail`, or the next silent-tick log entry that shows the flag reset on the tick after) as **(f) silence auto-cleared**.
4. No Slack "recovery" message is expected — the worker deliberately does not post one. The silent clear only shows in worker logs.

## How to log the drill result

Post the drill log as a **comment on the parent bet** — [Token-free fleet-liveness heartbeat](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/ec861955-00c0-447e-a72e-1b940a61ec0f).

**Do NOT edit the bet body's `## First test` section.** Bet descriptions are the canonical shaped input for the bet; agent and rehearsal outcomes belong in comments. Editing the description destroys the shape the Strategist wrote and confuses future sessions.

Include all six timestamps in the comment, in this order:

- (a) egress blocked / token invalidated
- (b) first heartbeat that shows `minutes_since > 8`
- (c) Slack message received
- (d) `fleet.silence_detected` dispatch visible in GH Actions
- (e) restore action taken
- (f) silence auto-cleared

Compute and state the MTTD as `(c) − (a)` in minutes. Note whether it clears the ≤10 min acceptance line. Attach or link the Slack message and the GitHub Actions run URL if easy.

If the drill missed — no Slack page inside 10 minutes, or no GH Actions receipt — write what you saw and what you tried. A missed drill outside the active-hours window is a runbook mistake, not a system failure; a missed drill inside the window means the alert path is broken and the bet's exit criteria triggers.

## Troubleshooting

- **No Slack message inside 10 minutes.** Confirm the drill started inside 07:00–23:00 Europe/Copenhagen. Tail the worker (`pnpm --filter @maskin/liveness-worker tail`) and look for `silent outside active hours` — that log line means the window gate rejected the tick.
- **No GH Actions receipt.** The `fleet-silence-detected.yml` workflow must live on `main`. A workflow on `bet/liveness-heartbeat` does not run on `repository_dispatch`.
- **Slack message shows `minutes_since: null`.** The worker treats a null `latest_completed_at` as silence too, which is correct. Check `apps/dev` logs for a DB error if this was not expected during the drill.
- **Worker tail is silent.** Confirm the worker is deployed to the fresh CF account and the cron trigger is enabled. `pnpm --filter @maskin/liveness-worker exec wrangler deployments list` shows the latest deploy.

## Notes on secrets

This document names environment variables and secret names only — never their values. Actual secret values live in Cloudflare Workers Secrets (`SLACK_WEBHOOK_URL`, `GH_DISPATCH_TOKEN`, `HEARTBEAT_SHARED_SECRET`, `HEARTBEAT_URL`) and in the `app` deployment env (`HEARTBEAT_SHARED_SECRET`). None of them share credentials with `claude_oauth` — that independence is the whole point of the bet, and pasting values here would defeat it.

If the endpoint path, secret names, or Slack channel drift from what appears in this runbook, update this file — a stale runbook is worse than none.
