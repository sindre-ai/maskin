# k6 load test: 30 agents and 100 human tabs (staging only)

Finds the breaking point of the API on purpose, before customers do. The script is
`scripts/loadtest/k6-agents-humans.js`. It replays the read pattern described in
`docs/runbooks/request-volume-audit-2026-10-27.md`: after each event every open tab refetches the
chat list, actors list, sessions list, For You, unread chats and the open chat, and keeps one
event stream (SSE) connection. Agents create, update and delete a throwaway task, which is what
produces the events.

## Never run this against production

The script aborts unless all of these hold:

- `ALLOW_STAGING=yes` is set.
- `BASE_URL` is not `maskin.io`, `www.maskin.io`, `api.maskin.io` or `maskin.sindre.ai`.
- The host name contains `staging`, `stg`, `test` or `loadtest` (or is `localhost`).

The staging host is not written in this repo (it is open source). Take it from the Coolify
staging application, or run the stack locally with `pnpm dev` and pass `http://localhost:3000`.

## What you need

- k6 v0.55 or newer (`brew install k6`, or the release tarball from the k6 GitHub releases page).
- A staging workspace, and the API key (`ank_...`) of a member of it. Use a throwaway workspace:
  the agents write and delete tasks named `k6-loadtest ...`, and every request becomes events.
- Read access to the staging database for the connection check below.

## Run

Start with the smoke profile (one minute, 5 tabs and 2 agents) to prove the credentials work:

    k6 run -e BASE_URL=https://<staging-host> -e ALLOW_STAGING=yes \
      -e API_KEY=ank_xxx -e WORKSPACE_ID=<staging-workspace-uuid> \
      scripts/loadtest/k6-agents-humans.js

Then the target load, and the step-up run that finds the limit:

    PROFILE=baseline    # 100 tabs and 30 agents, 2 min ramp, 10 min hold
    PROFILE=breakpoint  # 100 to 400 tabs and 30 to 120 agents in four 3-minute steps

Pass it as `-e PROFILE=baseline`. Optional: `-e AGENT_API_KEY=...` to write as a different member,
`-e SUMMARY_FILE=path.json` for the summary (default `k6-summary.json`).

The breakpoint profile stops itself when the error rate passes 5% or the 95th percentile of any
non-stream request passes 5 seconds. The load level at that moment is the breaking point.

## Read the result

The run prints requests per second, error rate and the 95th percentile (p95) per route, and
writes the same to the summary file. The event stream route always shows about 30 s: it is held
open on purpose and is left out of the thresholds.

Database connection use is not visible to k6. Sample it on staging every 10 s during the run:

    select count(*) filter (where state = 'active') as active, count(*) as total,
           current_setting('max_connections') as max
    from pg_stat_activity where datname = current_database();

For the slow queries, compare `pg_stat_statements` (total time by query) before and after the run.

## Cleanup

Agents delete what they create. If a run is killed half way, remove leftovers in the staging
workspace: tasks whose title starts with `k6-loadtest`.

## Limits of the model

- Humans are simulated as bursts of reads every 2 to 6 s, not by a real browser.
- Event streams are opened and held for 30 s, and the stream body is not parsed, so the delegation
  strip work done per session event is only exercised if sessions run in staging.
- iOS refetch behaviour is not modelled separately; it is the same reads.
