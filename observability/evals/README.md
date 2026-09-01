# MCP eval metrics

`apps/evals` writes Prometheus text exposition to `results/mcp-tools.prom` and
pushes the same series over remote_write. Both encodings come from one
definition — `metrics()` in `apps/evals/src/report.ts` — so a metric cannot
exist in the file and be missing from the push, or carry different labels in the
two.

## Wiring it up

The CI job (`.github/workflows/mcp-evals.yml`) runs
`pnpm --filter @maskin/evals push` after every suite, which POSTs a
snappy-compressed `WriteRequest` to:

| Secret | |
|---|---|
| `PROM_REMOTE_WRITE_URL` | e.g. `https://prometheus-prod-XX.grafana.net/api/prom/push` |
| `PROM_USERNAME` | Grafana Cloud stack's metrics instance id |
| `PROM_PASSWORD` | a Grafana Cloud access policy token with `metrics:write` |

Unset the URL and the push no-ops. **This is not a Grafana dependency** —
remote_write is a public protocol; Mimir, Thanos, VictoriaMetrics and a
self-hosted Prometheus with `--web.enable-remote-write-receiver` all accept the
identical body at a different URL.

## Metrics

| Name | Labels | |
|---|---|---|
| `maskin_eval_suite_pass_ratio` | `suite`, `model` | share of all attempts that passed |
| `maskin_eval_case_pass_ratio` | `+ case`, `kind`, `expected_tool` | per case |
| `maskin_eval_verdict_total` | `+ verdict` | attempts by outcome, passes included |
| `maskin_eval_tokens` | `+ kind` (`input`/`output`) | |
| `maskin_eval_run_duration_seconds` | `suite`, `model` | |
| `maskin_eval_run_timestamp_seconds` | `suite`, `model` | unix time the run started |

Cardinality is bounded by design: `case` ranges over the fixed set in
`cases.ts`. There is no per-run id and no timestamp label, so pushing this
repeatedly cannot grow the index.

## Panels

Overall health, and the same split by case kind — routing regressions and
build-the-thing regressions have different causes and should be read apart:

```promql
maskin_eval_suite_pass_ratio{suite="mcp-tools"}

avg by (kind) (maskin_eval_case_pass_ratio{suite="mcp-tools"})
```

Which case is dragging (table, instant, sorted ascending):

```promql
sort(maskin_eval_case_pass_ratio{suite="mcp-tools"})
```

How failures are distributed — `wrong_tool` points at a description, while
`bad_final_state` or `turn_limit` points at the workflow being genuinely hard:

```promql
maskin_eval_verdict_total{suite="mcp-tools", verdict!="pass"}
```

Staleness, in seconds. **Put this on every dashboard.** The suite runs only when
MCP tools change, so a months-old pass ratio otherwise renders exactly like a
current one:

```promql
time() - maskin_eval_run_timestamp_seconds{suite="mcp-tools"}
```

Cost of a run:

```promql
sum by (kind) (maskin_eval_tokens{suite="mcp-tools"})
```

## No alert rules — on purpose

There is deliberately nothing under `alerts/` here. This suite fires only on PRs
that touch the MCP surface, so the metric is legitimately stale most of the
time. Any threshold rule over it would page on absence rather than on a
regression, and a "no data" page that is usually wrong is worse than no page —
see `.claude/rules/known-pitfalls.md`, "A Grafana Alert Rule That Imports
Cleanly and Then Says Nothing Useful".

The gate that actually protects `main` is the `--min` pass-ratio check inside
the CI job, which fails the PR. These metrics are for reading a trend, not for
waking anyone up. If the cadence ever moves to a schedule, revisit this — and
add the rule to `observability/validate-alerts.py`'s coverage when you do.

## Verify by query, not by status

A 200 from the remote_write endpoint is not evidence the series landed. After
first setup, open Grafana Explore and confirm
`maskin_eval_suite_pass_ratio` returns rows. Same discipline as the Alloy
entries in the pitfalls registry: a healthy component that matches nothing looks
identical to a working one.
