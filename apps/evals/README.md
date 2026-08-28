# MCP tool evals

A tool description is a prompt. It can be reworded in a PR that passes lint,
types, unit, integration and E2E, and the only thing that notices is an agent
behaving oddly in production a week later. This suite is the gate for that.

**What it does not do:** check the schemas. `pnpm type-check` does that. What is
under test here is the *model* — given the descriptions and schemas that
`packages/mcp/src/tools.ts` ships today, does it pick the right tools and wire
them together.

## Running it

```bash
# Routing cases only — no server, no database, seconds.
ANTHROPIC_API_KEY=sk-... pnpm --filter @maskin/evals eval --kind routing

# Everything, including the trajectory cases. Needs the stack up.
pnpm dev            # or: pnpm dev:no-docker, inside an agent sandbox
ANTHROPIC_API_KEY=sk-... pnpm --filter @maskin/evals eval

# One case, while iterating on it.
pnpm --filter @maskin/evals eval --case create-loop-end-to-end
```

Results land in `apps/evals/results/` as `mcp-tools.json` (full transcripts of
what failed), `mcp-tools.prom` (Prometheus text exposition) and `summary.txt`.
The directory is gitignored.

| Flag | Default | |
|---|---|---|
| `--model` | `$EVAL_MODEL`, else `claude-opus-5` | |
| `--kind` | both | `routing`, `trajectory`, or both comma-separated |
| `--case` | all | comma-separated case ids |
| `--repeat` | 3 | attempts per routing case |
| `--trajectory-repeat` | 2 | attempts per trajectory case |
| `--min` | 0.9 | exit 1 below this overall pass ratio |
| `--concurrency` | 4 | attempts in flight |
| `--out` | `./results` | |

Environment: `ANTHROPIC_API_KEY` always; `DATABASE_URL` and (optionally)
`MASKIN_API_URL` for trajectory cases. Both are checked up front, so a missing
one fails with a sentence naming it rather than an SDK stack trace.

## Two kinds of case

**Routing** — one graded turn. The model is shown the six tools in
`COVERED_TOOLS` and we look at the first call it reaches for. Fast, hermetic,
no server involved. This catches "the description sends it to the wrong place".

**Trajectory** — a whole task, executed for real. The model gets the *entire*
MCP surface and drives it over `POST /mcp` against a running `apps/dev`, and the
assertion reads the workspace back afterwards. This catches "it can name the
right tools but cannot actually build the thing".

## Verdicts

| | |
|---|---|
| `pass` | |
| `wrong_tool` | called a tool, the wrong one |
| `bad_args` | right tool, arguments the handler could not act on |
| `missing_call` | a tool was required, none was called |
| `unexpected_call` | no tool was warranted, one was called |
| `bad_final_state` | trajectory: the workspace does not hold what was asked for |
| `tool_error` | trajectory: end state wrong *and* the server rejected a call |
| `turn_limit` | trajectory: ran out of turns without settling |

Grading is deterministic — no LLM judge, no similarity threshold. Every failure
is a fact about the transcript or the database, so a red bar is always
actionable and a green bar means the same thing it meant last month.

## Adding a case

A routing case is one entry in `cases.ts` and nothing else:

```ts
{
  kind: 'routing',
  id: 'search-by-keyword',
  intent: 'A keyword in the ask routes to search_objects',   // shown in the report
  prompt: 'Find anything we have written about onboarding drop-off.',
  expectTool: 'search_objects',
  expectArgs: (input) => (input.q ? null : 'no query passed in `q`'),
}
```

`expectArgs` returns `null` to pass, or the sentence you would want to read at
2am. It lands in the report verbatim.

A trajectory case adds `maxTurns` and an `expect(trajectory, fixture)`. **Assert
the outcome, not the tool names.** `create-loop-end-to-end` reads the workspace
back and checks that a loop exists with steps that resolve to agents that exist;
it does not care whether the triggers came from `create_loop`'s inline `steps[]`
or from separate `create_trigger` calls, because both are correct and pinning
one would fail the eval on an improvement.

## Three things that look like details and are not

**The routing system prompt is deliberately thin.** Coaching the model there
("prefer search when you see a keyword") would move the signal out of the tool
descriptions and into `run.ts`, hiding a description that has stopped earning
its place. Trajectory cases go the other way and use the real
`CHIEF_OF_STAFF_SYSTEM_PROMPT`, because that is the agent they stand in for.

**Tools are imported from source, not from `@maskin/mcp`.** That package's
exports map resolves `default` to `./dist`, so importing the package name would
grade the last build instead of the working tree — the stale-`dist` trap in
`.claude/rules/known-pitfalls.md`.

**Each trajectory attempt gets its own empty workspace, seeded via the database
rather than `POST /api/workspaces`.** Every HTTP path that creates a workspace
runs `provisionWorkspace()`, which seeds the default agent roster, workspace
skills, triggers, *default loops*, and a Chief of Staff kickoff container
session. An eval asking "did the model build a loop" cannot start in a workspace
that already contains loops. It also makes attempts independent, so
`--concurrency` is safe and any failure reproduces in isolation.

## CI and metrics

`.github/workflows/mcp-evals.yml` runs the suite on PRs that touch
`packages/mcp/**`, `apps/evals/**` or `packages/shared/src/templates/**` — not
on every PR, because every attempt costs real API calls. It boots the same
Postgres + SeaweedFS + built-bundle stack the integration tests use.

`pnpm --filter @maskin/evals push` ships the run to `PROM_REMOTE_WRITE_URL`.
remote_write is a public protocol, so pointing this at Mimir, Thanos,
VictoriaMetrics or a self-hosted Prometheus is a URL change and nothing else —
no eval case, grader or metric definition knows who is receiving them. It no-ops
when the URL is unset and never fails the job on a push error. Dashboard PromQL
is in `observability/evals/README.md`.
