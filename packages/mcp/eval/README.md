# MCP surface eval harness

Drives a real agent against a staging Maskin through the HTTP `/mcp` path, on tasks whose
outcome is checked by a plain query of staging state. No LLM judge. Built for the
[MCP tool surface bet](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/11e0c190-76c0-4b55-be2b-3ac33211f7ad)
(tech spec sections 6, 8 and 15.7): record a baseline on the current surface, re-run after
every change, and compare with the "no worse" rule.

Not a workspace package. It has its own `package.json` so the Agent SDK stays out of the
app's install and lockfile. The pure logic (telemetry counting, checkers, pass-rate summary)
is unit tested in `packages/mcp/src/__tests__/eval-harness.test.ts`, which CI runs.

## Layout

| Path | What |
|------|------|
| `run.ts` | CLI. One invocation is one step: every selected task, `--runs` times, one results file. |
| `tasks/index.ts` | The six task definitions: setup, prompt, checker. |
| `lib/runner.ts` | The Agent SDK runner (`query()` with the Maskin MCP over HTTP). |
| `lib/run-task.ts` | One run: seed, start the agent, read telemetry, check, build the result row. |
| `lib/telemetry.ts` | Counts `tool_call` and `error` rows in `mcp_telemetry` for a session id. |
| `lib/state.ts`, `lib/seed.ts` | Read-only SQL view of staging state, REST writes to seed a task. |
| `lib/summary.ts` | Pass rates, calls per passing task, cost. |
| `results/` | One JSON file per step. The baseline is committed here. |

## Runner

The runner is the Agent SDK one: TypeScript `query()` with the Maskin MCP attached over
HTTP, the harness key in the `Authorization` header, and a fresh uuid in `X-Maskin-Session-Id`
for every run. Every result row records `runner: "agent-sdk"`.

`create_session` over HTTP was checked first and cannot be the runner:

- Its input takes `workspace_id`, `actor_id`, `action_prompt`, `source_session_id`,
  `initiated_from_object_id`, `spawned_by_message_id` and `wait`. There is no model and no
  config, so the model cannot be pinned, and a before and after comparison needs the same model.
- A local staging stack has no agent server. `create_session` there only writes a session row
  that stays `pending`, so no agent would run.

Where each number comes from:

| Column | Source |
|--------|--------|
| `call_count` | `mcp_telemetry` rows with `event_type = tool_call` and `session_id` = the run's uuid |
| `errors_by_kind` | `mcp_telemetry` rows with `event_type = error`, kind from `data->>'kind'`: `tool_not_found`, `unknown_param`, `schema_validation_error`. No other taxonomy. |
| `tokens` | The Agent SDK result message (`modelUsage`, summed over models). Not taken from sessions: a local stack runs none. |
| `cost_usd` | The Agent SDK result message (`total_cost_usd`, an estimate) |
| `client_tool_uses`, `client_tool_errors` | Counted from the SDK message stream. A call that fails argument validation writes an error row but no `tool_call` row, so `client_tool_uses` is the count of attempts. |

Two things the telemetry does not do, found while building this:

- A call that fails argument validation writes an error row and **no** `tool_call` row. So
  `call_count` counts calls that reached a handler.
- A "Not found" reply (for example a skill id sent as a skill name) writes **no** error row.
  Only validation, unknown tool and unknown parameter are classified.

## Tasks

Prompts describe the outcome in plain words and never name an argument. A unit test enforces
that. Each task creates its own objects, titled with the first 8 characters of the run uuid, so
runs do not collide.

| Id | Held out | Drifted parameter | Outcome checked |
|----|----------|-------------------|-----------------|
| `T1-bet-with-tasks` | no | edge source and target | a bet and three tasks exist, and the bet breaks into each task (source = bet) |
| `T2-read-by-ids` | no | get by ids | a note holds the three codes found in three seeded objects |
| `T3-set-driver` | no | driver on update | the task's driver is the helper agent |
| `T4-list-links` | yes | relationship listing | a note lists the three connected objects (edges in both directions) and none of the decoys |
| `T5-start-session` | yes | `create_session` arguments | a session row exists for the helper agent, linked to the task, carrying the instruction text |
| `H6-skill-lookup` | no | skill lookup by id or name | the stored skill content is the old content plus `eval-marker-<run id>`, and the session has no error rows for `get_workspace_skill` or `update_workspace_skill` |

`create_session` on the current surface has no `config` argument, so `T5` probes the arguments
it does have.

The no-worse rule reads the original five (`T1` to `T5`). `H6` is reported on its own line and
counts as passed in a step only when all three runs pass. A run passes `H6` only with the stored
content right, no error rows for the two skill tools, and zero "Not found" replies to
`get_workspace_skill`. The prompt tells the agent to fetch by id, so a "Not found" there is the
failure the id-or-name change removes. It writes no error row, so the runner reads it from the
agent's own tool errors and records it per tool in `client_not_found_by_tool`. Without this rule
`H6` would pass at baseline and could not show an improvement.

## Staging

The harness needs a throwaway stack: its own Postgres, a workspace, a harness actor with its
own API key, and one seed skill named `eval-h6-skill-lookup`. Infra & DevOps documented how to
boot and seed it in the [staging runbook](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/db3ff98b-b758-4cce-bb7d-b7ee12d9ae2b)
(local stack, no Docker, built from `main` for the baseline and from the bet branch for the after run). Staging is apart from the production database, so harness runs
cannot reach the daily misfire number. They are identifiable by the staging workspace id and the
session ids in every row. The harness refuses an API URL containing `maskin.io` or `sindre.ai`.

## Run it by hand

```
cd packages/mcp/eval
npm install                       # the Agent SDK, pinned in package.json

export MASKIN_EVAL_API_URL=http://localhost:3000     # from eval-harness.env
export MASKIN_EVAL_WORKSPACE_ID=<staging workspace id>
export MASKIN_EVAL_API_KEY=<harness actor key>
export DATABASE_URL=<the stack's Postgres url>       # read only queries
export MASKIN_REPO_ROOT=<checkout the stack was built from>
export ANTHROPIC_API_KEY=<the capped harness key>    # pays for the runs

pnpm exec tsx run.ts --step baseline --runs 3        # from the repo root: pnpm exec tsx packages/mcp/eval/run.ts ...
pnpm exec tsx run.ts --step dry-run --runs 1 --tasks T3-set-driver
```

Options: `--step` (required label, for example `baseline` or `after-aliases`), `--runs`
(default 3), `--tasks` (comma separated ids, default all), `--out` (default `results/`).

Environment: `EVAL_MODEL` (default `claude-sonnet-5-5`), `EVAL_MAX_TURNS` (30),
`EVAL_RUN_TIMEOUT_MS` (300000), `EVAL_MAX_COST_USD` (40; the invocation stops and writes what it
has once spend passes it).

`MASKIN_REPO_ROOT` matters twice: the read only Postgres driver is borrowed from its
`packages/db`, and its git sha and branch are written into the results file, because that
checkout is what was measured.

Use the same `EVAL_MODEL` for every step you compare.

## Results file

`results/<step>-<start time>-<sha>.json` holds `step`, `runner`, `model`, `stack_git_sha`,
`stack_git_branch`, `staging_workspace_id`, `summary` and one row per task run:
`task_id`, `held_out`, `run_index`, `session_id`, `workspace_id`, `passed`, `check_reason`,
`call_count`, `tokens`, `tokens_source`, `cost_usd`, `errors_total`, `errors_by_kind`,
`error_rows_by_tool`, `client_tool_uses`, `client_tool_errors`, `client_not_found_by_tool`, `num_turns`, `duration_ms`,
`run_date`, `runner`, `model`, `run_error`.

`summary.original` is the line the no-worse rule reads: pass rate and calls per passing task over
`T1` to `T5`. `summary.h6` is reported separately.
