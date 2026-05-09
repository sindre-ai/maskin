# scripts/e2e

Black-box end-to-end tests that hit a running Maskin instance over its public REST API.
These do not run in unit/integration CI — they are slow (30–90 minutes per run) and
require a live workspace, real agents, and an LLM budget. Schedule them periodically
or run them manually after shipping changes that touch orchestration.

## `parallel-bet-autonomy.ts`

The Parallelization bet's (`f98547ae`) acceptance instrument. Creates a synthetic
bet with four tasks in a diamond dependency graph (T1 → T2,T3 → T4), walks away,
and polls until either every task is `done` and the bet is `completed` (PASS) or a
wall-clock budget elapses (FAIL with a diagnostic dump of task states, recent
events, notifications, and per-task sessions).

The synthetic bet uses `POST /api/graph` (the same endpoint MCP `create_objects`
calls) and creates tasks with prose dependencies only — `blocks` edges are not
pre-populated, so the run also verifies that the Bet Decomposer materializes
edges from prose. Tasks are intentionally tiny (a single doc line per task) so
they can land via the normal dev → review → CTO chain without bouncing.

### Run manually

```bash
MASKIN_API_BASE_URL=https://your-maskin.example.com \
MASKIN_API_KEY=sk-... \
MASKIN_WORKSPACE_ID=00000000-0000-0000-0000-000000000000 \
pnpm test:e2e:parallel-bet
```

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `MASKIN_API_BASE_URL` | `http://localhost:5173` | Base URL of the running web app |
| `MASKIN_API_KEY` | (required) | Bearer token for an actor with workspace write access |
| `MASKIN_WORKSPACE_ID` | (required) | Target workspace UUID |
| `E2E_BUDGET_MIN` | `90` | Wall-clock minutes before FAIL |
| `E2E_POLL_SEC` | `30` | Seconds between bet-state polls |
| `E2E_REQUEST_TIMEOUT_SEC` | `30` | Per-request fetch timeout. A single hung API call aborts and is surfaced as a fatal error; the outer wall-clock budget is no longer the only bound. |
| `E2E_REPORT_PATH` | unset | If set, write the JSON report to this path |
| `E2E_KEEP_OBJECTS` | unset | Set to `1` to keep the synthetic bet/tasks after a PASS run (FAIL runs already keep them) |
| `E2E_CLEANUP_ON_FAIL` | unset | Set to `1` to opt back in to deleting the synthetic bet/tasks on FAIL. Default: keep them so the diagnostic dump's IDs resolve during root-causing |

### Cleanup behavior

- **PASS** — synthetic bet and tasks are deleted, unless `E2E_KEEP_OBJECTS=1`.
- **FAIL** — synthetic bet and tasks are kept by default so the diagnostic dump
	stays useful. Set `E2E_CLEANUP_ON_FAIL=1` to delete them anyway.

### Reliability

`api()` retries transient errors (HTTP 408/425/429/5xx and network failures) up
to three times with exponential backoff (500ms / 1s / 2s). The synthetic-bet
creation call passes `Idempotency-Key: <RUN_ID>` so a retried request after a
partial failure cannot double-create the bet.

**Per-request abort-timeouts are intentionally not retried.** When
`E2E_REQUEST_TIMEOUT_SEC` fires and the `AbortController` cancels the in-flight
fetch, `api()` throws a plain `Error` (`<METHOD> <PATH> aborted after <N>s
(E2E_REQUEST_TIMEOUT_SEC)`). `isRetriable` (`retry.ts`) only classifies
`ApiError` (transient HTTP statuses) and `TypeError` (fetch network failures)
as retriable, so an abort is treated as a fatal signal for the whole run.

The split is deliberate: bounded retries exist for transient blips
("the network was bad for 200ms"), whereas a per-request timeout means *this
one call has been hung for 30s* — the most likely explanations are an
unresponsive server or a lost connection that fetch hasn't surfaced yet.
Silently retrying that case would double or triple the wall-clock cost of a
real outage and risk the harness running for hours against a dead workspace
before the outer wall-clock budget kicks in. Treating it as fatal lets a 90-
minute scheduled run fail fast and surface a clear root cause in the report
instead of accumulating retries no one is watching.

If a future change wants aborts to be retried, convert the abort path in
`api.ts` to throw a typed retriable error and add a corresponding case to
`isRetriable` and `retry.test.ts` — do not loosen the policy implicitly.

### Exit codes

- `0` — PASS
- `1` — FAIL (budget elapsed)
- `2` — Fatal error before the run could reach a verdict

### Output

A JSON report is printed to stdout (and optionally to `$E2E_REPORT_PATH`) with
end-to-end cycle time, per-task cycle times, max parallelism observed, total
watchdog kicks across the bet's tasks, the final snapshot, all notifications
generated against the bet, and on FAIL a recent-events tail and per-task
session list.

### Where the results go

The `e2e-parallel-bet-autonomy` GitHub Actions workflow runs this on a weekly
schedule (Sundays 04:00 UTC) and as a manual `workflow_dispatch`. Reports are
uploaded as workflow artifacts. The Parallelization bet's measurement window
(May 17, 2026) consumes the most recent PASS report by hand for now; once
results-store wiring lands, the workflow will post a summary to the bet via
`POST /api/events` instead.
