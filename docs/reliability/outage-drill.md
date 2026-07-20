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

---

# Multi-credential failover drill (Option B — chosen direction)

This is the drill that ships with the on-`main` credential-level failover — the direction the bet is now committed to. The CF Workers detection stack above stays as a parked defense-in-depth for the all-credentials-die tail case.

The drill simulates a **primary credential failure** and verifies the deployed backup slot picks up in-flight sessions with zero user-visible failure. Two invalidation paths are covered so both the OAuth-death shape and the rate-limit-rejection shape are exercised — the second one exists because a rate-limit rejection produces a session signature structurally identical to OAuth death (see insight `58dc6cb6-5ef7-46ab-a158-611f054604cf`), and if the backup slot shares a Claude org / 5-hour bucket with primary, failover for that mode is a silent no-op.

## Prerequisites

1. `MASKIN_CLAUDE_FAILOVER_ENABLED=true` is set on the running `app` deployment. Confirm with the deployment env dump; without the flag, `resolveClaudeCredentialsWithFailover` short-circuits to primary-only and no failover happens.
2. The workspace under drill has both `primary` and `backup` slots populated on `workspaces.settings.claude_oauth`. Verify:

   ```sql
   SELECT settings->'claude_oauth' AS oauth
   FROM workspaces
   WHERE id = '<workspace_id>';
   ```

   Expect the new-shape row `{ primary: {...}, backup: {...}, failover?: {...} }` — a bare `{ encryptedAccessToken, ... }` legacy row means the backup slot was never provisioned.
3. `MASKIN_FALLBACK_OPENROUTER_KEY` is set in the deployment env (LLM route tier below `oauth`).
4. The backup slot is verified to sit on an **independent Claude org from primary** — see the next section. This is the gate that keeps the rate-limit variant of the drill honest.

## Verify the backup slot's Claude org is independent from primary

The 5-hour rate-limit bucket is scoped per Claude org / account, not per credential. Two credentials imported from the same Claude subscription share the same bucket, so failing over from one to the other does not help when the bucket is what got drained.

To verify independence before running the rate-limit drill:

1. In the workspace UI, open **Settings → Keys → Claude subscription**. The primary and backup slots each render the connected account's email / display name from the token's introspection cache.
2. Confirm the two accounts are owned by different humans OR by the same human on different Claude subscriptions (different `organizations[].uuid` values in the OAuth token payload). Two credentials from the same account (e.g. two OAuth flows against the same Claude Pro subscription) will collide on the 5-hour bucket even though they present as distinct tokens.
3. If you have direct DB access, decrypt one token from each slot in a scratch script and hit `GET https://api.anthropic.com/api/oauth/user_info` with each. The response includes `organization.uuid`. The two must differ.
4. Record the two org UUIDs (or account owners) in the drill log as evidence that this precondition held — a drill that passes on OAuth-death but silently no-ops on rate-limit-rejection because both slots shared a bucket is exactly the failure mode this task exists to prevent.

If the two slots turn out to share an org, stop the drill and provision a backup on a different account before continuing.

## Invalidation path (a) — OAuth-death shape

Reproduces the June 28 outage: primary token becomes unusable, `resolveClaudeCredentialsWithFailover` classifies the 401 (or refresh-time 4xx) as `auth_failed` → `failover`, flips `active_slot` to `backup`, and emits `claude_subscription_failover_triggered`.

1. On the `app` deployment, overwrite the primary slot's encrypted access token with a garbage blob so refresh fails. In a scratch script:

   ```ts
   await db.update(workspaces)
     .set({ settings: sql`jsonb_set(settings, '{claude_oauth,primary,encryptedAccessToken}', to_jsonb('deadbeef'::text))` })
     .where(eq(workspaces.id, WORKSPACE_ID))
   ```

   (Do NOT delete the primary slot — the flag-off path reads `slots.primary` directly and a missing primary returns `null` without exercising the classifier.)
2. Record the wall-clock time as timestamp **(a1) primary invalidated**.
3. Start (or wait for) a new agent session on the drilled workspace. `resolveClaudeCredentialsWithFailover` runs on session start, probes primary, classifies the failure, flips `active_slot`, and returns backup credentials.

## Invalidation path (b) — rate-limit rejection shape

This is the T6-added variant. Reproduces the late-morning cron failure mode from the insight: primary responds with `HTTP 429` and a body carrying `{ type: "rate_limit_error" }` OR a nested `rate_limit_event { rateLimitType: "five_hour", overageStatus: "rejected" }`. The classifier now inspects both the `anthropic-ratelimit-unified-status: exhausted` header AND the body shape, so either signal trips the same `quota_exhausted` → `failover` verdict.

Two ways to reproduce, from cheapest to most realistic:

**(b.i) — Inject a synthetic 429 into the probe.** Override the default probe with a test double that returns the exact classifier input the runtime path will see. In a scratch script that instantiates the same `resolveClaudeCredentialsWithFailover` from `apps/dev/src/lib/claude-failover.ts`:

```ts
await resolveClaudeCredentialsWithFailover({
  db,
  workspaceId: WORKSPACE_ID,
  actorId: ACTOR_ID,
  probe: async () => ({
    kind: 'http',
    status: 429,
    headers: headersFrom({}),
    body: {
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', overageStatus: 'rejected' },
    },
  }),
})
```

Fast and deterministic — proves the classifier path end-to-end without needing to actually drain a real Claude bucket. Expected: the workspace's `failover.active_slot` flips to `backup` and one `claude_subscription_failover_triggered` event lands with `reason: quota_exhausted`.

**(b.ii) — Drain the primary's real 5-hour bucket.** Only run this when you also want to confirm the live Anthropic API behaviour matches the synthetic shape. Fire a burst of paid-tier calls against the primary credential until the bucket rejects. This burns real quota on primary and takes long enough that (b.i) is the recommended default; run (b.ii) at most once per bet cycle as a live-fire sanity check.

For either variant, record the wall-clock time as timestamp **(a2) primary rate-limited**.

## What to expect (both invalidation paths)

Inside the same session that observed the failure:

1. A `claude_subscription_failover_triggered` event is written to the `events` table for the workspace, with `data.reason = "auth_failed"` (path a) or `"quota_exhausted"` (path b). Record when the event lands as **(b) failover event fired**.
2. `workspaces.settings.claude_oauth.failover.active_slot` is set to `"backup"`. Record the moment you can `SELECT settings->'claude_oauth'->'failover' FROM workspaces WHERE id = '...'` and see the flip as **(c) active_slot = backup**.
3. The container that triggered the classifier receives backup credentials on the same startup path (session-start probe) or is retried on backup mid-run (runtime failover from `maybeRetryClaudeOAuthOnBackup`). Record the timestamp of the first agent step that completed successfully after (a) as **(d) first successful step on backup**.
4. PostHog receives a `claude_subscription_failover_triggered` capture with matching `reason` + `failure_window`. Not blocking for the drill, but attach the PostHog event id in the drill log if easy.

Target: (d) − (a) ≤ 2 minutes (session-start path) or ≤ 5 minutes (runtime retry path). Zero user-visible failure means the same session — or its auto-retry — completes without needing manual intervention.

## How to restore

1. Path (a): restore the primary slot's original encrypted access token from the pre-drill DB snapshot (or re-import via `POST /api/claude-oauth/import`). Path (b): no restore needed — the synthetic probe override in (b.i) is scoped to the scratch script. If you ran (b.ii), wait for the real 5-hour bucket to reset.
2. In both cases, clear the failover state so the next session probes primary again:

   ```sql
   UPDATE workspaces
   SET settings = jsonb_set(settings, '{claude_oauth,failover}',
     '{"active_slot":"primary"}'::jsonb)
   WHERE id = '<workspace_id>';
   ```

   Alternatively, wait for T7's lazy primary-recovery to fire — `attemptPrimaryRecovery` will flip back to primary automatically once its cooldown has elapsed and the health check passes. Record the recovery timestamp as **(e) primary recovered**.
3. Confirm a fresh session on the workspace routes to primary again by observing `claude_subscription_recovered` in the events table.

## How to log the drill result

Post the drill log as a **comment on the parent bet** — [Enable and drill multi-credential failover so a lapsed token doesn't stall the fleet](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/ec861955-00c0-447e-a72e-1b940a61ec0f).

Include:

- Which invalidation path(s) you ran: (a) OAuth-death, (b.i) synthetic 429 body, (b.ii) real bucket drain.
- All four timestamps: **(a)** primary invalidated / rate-limited, **(b)** failover event fired, **(c)** active_slot flipped, **(d)** first successful step on backup, plus **(e)** primary recovered if you completed restore.
- Time-to-continuity `(d) − (a)`, per path. Note whether it clears the target above.
- Evidence that the backup slot's Claude org UUID (or account owner) differs from primary — this is the check that makes the (b) result meaningful. Attach both org UUIDs or the two account owners.
- Whether any user-visible failure surfaced: aborted sessions, error banners in the UI, missed cron runs on the drilled workspace. Zero is the acceptance line.

If path (b) is skipped without the independent-org evidence, the drill does not close [T6](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/93a092e3-ac5a-4678-998c-b33bdc9a84fe) — the whole point of this section is to prevent a passing OAuth-death drill from masking an unprotected rate-limit failure mode.
