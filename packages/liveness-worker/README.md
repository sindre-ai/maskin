# @maskin/liveness-worker

Off-fleet Cloudflare Workers cron that polls the fleet-liveness heartbeat, detects silence, and pages Slack + fires a GitHub `repository_dispatch` when the fleet stops answering. Substrate for the parent bet [Token-free fleet-liveness heartbeat](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/ec861955-00c0-447e-a72e-1b940a61ec0f) — the entire point is independence from `claude_oauth`, so **do not reuse any credential connected to the primary Claude route** when provisioning below.

## What it does

Every 2 minutes (`*/2 * * * *`) the worker:

1. `GET`s `${HEARTBEAT_URL}` with header `X-Heartbeat-Secret: ${HEARTBEAT_SHARED_SECRET}`. See the T1 endpoint at `apps/dev/src/routes/fleet-heartbeat.ts`.
2. Classifies the result as silent if any of: `minutes_since > SILENCE_THRESHOLD_MIN`, a null `latest_completed_at`, a non-2xx response, a malformed body, or a network error.
3. Gates the page on active hours (default `07:00–23:00 Europe/Copenhagen`, DST-aware via `Intl.DateTimeFormat`).
4. Dedups against a Workers KV flag (binding `SILENCE_STATE`, key `silence_active`) — only the first silent tick inside a silence window pages; the flag is cleared on the next clean heartbeat.
5. When it pages, POSTs `SLACK_WEBHOOK_URL` (single try — Slack outage during a fleet outage is out of scope) and POSTs `POST /repos/${GH_DISPATCH_REPO}/dispatches` with `event_type: "fleet.silence_detected"`.

## Prerequisites (humans)

- A **fresh Cloudflare account** independent of any credential connected to `claude_oauth`. Owner: Sebk.
- A Slack app + Incoming Webhook posting to `#fleet-outages`. Owner: Sebk.
- A **GitHub fine-grained PAT** scoped to `repository_dispatch: write` on `sindre-ai/maskin` only, nothing else. Owner: Magnus.
- The T1 heartbeat endpoint mounted at `https://<app-host>/api/internal/fleet-heartbeat` with `HEARTBEAT_SHARED_SECRET` set on the app side. Contract in the ADR.

## Deploy

```sh
# 1. Log wrangler into the fresh CF account.
pnpm --filter @maskin/liveness-worker exec wrangler login

# 2. Create the KV namespace and paste its id into wrangler.toml (replace REPLACE_WITH_KV_NAMESPACE_ID).
pnpm --filter @maskin/liveness-worker exec wrangler kv namespace create SILENCE_STATE

# 3. Provision the four secrets. Values are entered interactively — never checked in.
pnpm --filter @maskin/liveness-worker exec wrangler secret put HEARTBEAT_URL
pnpm --filter @maskin/liveness-worker exec wrangler secret put HEARTBEAT_SHARED_SECRET
pnpm --filter @maskin/liveness-worker exec wrangler secret put SLACK_WEBHOOK_URL
pnpm --filter @maskin/liveness-worker exec wrangler secret put GH_DISPATCH_TOKEN

# 4. Deploy.
pnpm --filter @maskin/liveness-worker deploy

# 5. Tail logs live (useful during the outage drill in T4).
pnpm --filter @maskin/liveness-worker tail
```

## Local dev

```sh
pnpm --filter @maskin/liveness-worker dev
```

For a wet run against a scratch environment, put `.dev.vars` alongside `wrangler.toml` (git-ignored) — `wrangler dev` will read it. Never commit that file.

## Configuration

| Variable                  | Kind    | Default                | Notes                                                                                                          |
| ------------------------- | ------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `HEARTBEAT_URL`           | secret  | –                      | Full URL to the T1 endpoint. Secret only because it names the app host.                                        |
| `HEARTBEAT_SHARED_SECRET` | secret  | –                      | Same value as `HEARTBEAT_SHARED_SECRET` on the app side.                                                        |
| `SLACK_WEBHOOK_URL`       | secret  | –                      | Slack incoming-webhook URL that posts to `#fleet-outages`.                                                     |
| `GH_DISPATCH_TOKEN`       | secret  | –                      | Fine-grained PAT scoped to `repository_dispatch: write` on `sindre-ai/maskin`.                                 |
| `SILENCE_THRESHOLD_MIN`   | var     | `8`                    | `minutes_since > threshold` triggers silence.                                                                  |
| `ACTIVE_HOURS`            | var     | `07:00-23:00`          | Window in `HH:MM-HH:MM` form. Interpreted in `ACTIVE_TIMEZONE`.                                                |
| `ACTIVE_TIMEZONE`         | var     | `Europe/Copenhagen`    | IANA tz. DST-aware via `Intl.DateTimeFormat` — do not hardcode a UTC offset here.                              |
| `GH_DISPATCH_REPO`        | var     | `sindre-ai/maskin`     | `<owner>/<repo>` for the dispatch endpoint.                                                                    |
| `BET_URL`                 | var     | (bet URL)              | Rendered into the Slack message so on-call can click through.                                                  |
| `SILENCE_STATE`           | KV bind | –                      | Workers KV namespace holding the single-key dedup flag.                                                        |

## Tests

```sh
pnpm --filter @maskin/liveness-worker test
pnpm --filter @maskin/liveness-worker type-check
```

Tests mock `fetch` and stub the KV namespace — no Cloudflare account is needed. Coverage includes silence eval (in-window, out-of-window, threshold boundary, spring + autumn DST boundaries), 5xx handling, network-error handling, dedup across two ticks, and Slack + dispatch payload shapes.

## What this worker deliberately does NOT do

- **Retry the Slack POST.** A Slack outage during a fleet outage is a compounding failure worth logging but not solving here.
- **Post a "recovery" Slack message when the fleet comes back.** Nice-to-have, not required for MTTD — the flag clears silently.
- **Emit its own PostHog event.** The bet measures MTTD from the Slack page-fire timestamp vs the last-heartbeat timestamp; there is no new event to instrument.
- **Rate-limit itself.** 720 invocations/day sits well under the CF free tier's 100k/day.
