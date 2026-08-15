---
name: risk-classifier
version: 0.1.0
description: Use to score a PR diff on the 0–100 risk band that gates the auto-merge pipeline. Triggers on every `pull_request` opened/synchronize/reopened/ready_for_review event against `main`, and on demand from the `orchestrate-pr-review` skill. The skill produces a deterministic score from a fixed signal table (path sensitivity, DDL detection, secrets-like patterns, SAST alerts, incident density, and friends), applies the floors declared in `.maskin/protected-paths.yml` and `.maskin/risk-floors.yml`, and emits a `## Risk Score` block plus a `maskin/risk-score` check run. Do NOT use to *decide* whether to merge — that's `orchestrate-pr-review`'s job. Do NOT use to author code or critique style — score, output, stop.
---

# Risk Classifier

A deterministic 0–100 score over a PR diff. Same inputs in → same score out, every time, on every SHA. The classifier is the data layer of the auto-merge bet (`bb682faa`); without a stable score there is nothing for the approver to gate on.

## When to invoke

- A `pull_request` event arrives with action `opened`, `synchronize`, `reopened`, or `ready_for_review` against `main`.
- The `orchestrate-pr-review` skill asks for the score for a specific commit SHA.
- A human asks "what would the classifier score this?" on an open PR.

The skill re-runs on every `synchronize` (per-SHA). The previous verdict is invalidated as soon as the head SHA moves; never carry forward.

## Do NOT invoke

- After a merge has already happened — the score has no consumer.
- For PRs targeting branches other than `main` — branch protection only enforces the gate on `main`.
- As a substitute for `review-checklist` (correctness, tests, naming) or `security-review` (OWASP/STRIDE). The classifier is *triage*, not *review*.
- To "improve" the diff. The score is read-only output; do not edit code, propose fixes, or comment lines.

## Method

Walk these in order. Each step is non-negotiable; skipping any step makes the verdict non-deterministic.

### 1. Resolve the diff

Run the adapter binary at `packages/risk-classifier/bin/risk-classifier.mjs`. Pass:

- `--base` = PR base SHA (the merge target's head at PR-open time)
- `--head` = PR head SHA from the webhook payload
- `--repo` = path to the checkout
- `--cve-dep <name@version>` for each newly-introduced dependency that already has a CVE
- `--missing-tests` if the diff includes logic-bearing files but no test changes
- `--ai-generated` if the PR body or commit trailers carry an AI-authoring marker
- `--public-api-delta <n>` for the count of public symbols added/removed
- `--incident-density <file.json>` if Sentry/PagerDuty data is available

The adapter reads `.maskin/protected-paths.yml`, `.maskin/risk-floors.yml`, and `.maskin/hot-tables.yml` from the repo, runs `git diff` between the two SHAs, runs `squawk` on `.sql` files, and runs Semgrep diff-scan. It returns a `ClassifierVerdict` JSON object.

### 2. Apply the signal table

Sum the weights of every triggered signal. Cap the sum at 100.

| Signal | Weight |
| --- | --- |
| `diff_loc` | bucketed: 6 / 12 / 20 / 30 at 50 / 200 / 500 / 1000 LOC |
| `files_changed` | bucketed: 5 / 10 / 15 at 5 / 15 / 30 files |
| `paths_auth_session` | +15 |
| `paths_payments_billing` | +20 |
| `paths_crypto_kms` | +20 |
| `paths_iam_policy` | +15 |
| `paths_migrations_ddl` | +15 (also runs squawk) |
| `paths_iac` | +15 |
| `paths_gha_workflows` | +20 |
| `public_api_surface_delta` | +10 |
| `new_deps_with_cve` | +25 |
| `secrets_like_patterns` | +30 |
| `missing_tests_for_logic` | +10 |
| `top_decile_incident_file` | +10 |
| `file_unchanged_365d` | +5 |
| `ai_generated_marker` | +5 |
| `codeql_or_semgrep_alert` | severity-weighted: 30 / 20 / 8 / 2 (CRITICAL / ERROR / WARNING / INFO) |
| `squawk_blocking_lock` | +15 |

### 3. Apply the floors

Floors override the additive sum. Apply in this order:

- **Protected path** — any file matches a glob in `.maskin/protected-paths.yml` → score = 100, regardless of additive sum.
- **Regex floor** — any line matches a pattern in `.maskin/risk-floors.yml` → score = max(additive_sum, 60).
- **Squawk hot-table hit** — squawk flags a blocking lock against a table in `.maskin/hot-tables.yml` → score = max(additive_sum, 60).

The additive sum and the floors are independent computations; the final score is the maximum of all of them, capped at 100.

## Verdict

Exactly one band. Not a range, not "around 30," not "depends." Pick.

- **AUTO-APPROVE ELIGIBLE** — `score < 25`. The PR is eligible for `orchestrate-pr-review` to consume; it does not auto-approve here.
- **AGENT RECOMMENDS HUMAN** — `25 ≤ score < 60`. Orchestrator runs perspectives but never submits APPROVE.
- **TWO-HUMAN REQUIRED** — `score ≥ 60`. Orchestrator stops and routes to humans.

## Output

Write the verdict on the **task** linked from the PR's `github_link`, under a `## Risk Score` heading, with this structure:

```markdown
## Risk Score

**Score:** <0-100>/100 — <BAND LABEL>
**Skill version:** 0.1.0
**Commit:** <head-sha>
**Deterministic seed:** <16-hex>

### Signals
- `paths_auth_session` +15 — packages/auth/src/session.ts
- `diff_loc` +12 — 240 lines changed across 3 files

### Floors applied
- `protected_path` — packages/auth/** matches packages/auth/src/session.ts
```

Also post the `maskin/risk-score` GitHub check run with conclusion:

- `success` for `AUTO-APPROVE ELIGIBLE`
- `neutral` for `AGENT RECOMMENDS HUMAN`
- `failure` for `TWO-HUMAN REQUIRED`

The check-run summary includes the score and band; the full block goes on the task, not on the PR (the PR is a projection of the task).

## Attestation

Record the skill version (`0.1.0`) and the deterministic seed in the in-toto attestation built by `orchestrate-pr-review`. The orchestrator binds the version to the verdict; bumping `version:` in this skill's frontmatter must accompany any change to the signal table, weights, floors, or output format.

## What NOT to do

- Do not invent a signal that isn't in the table. The table is the contract; new signals require a version bump and a bet revision.
- Do not produce a non-deterministic score. If the adapter cannot reach a sub-tool (squawk, semgrep, incident density), the affected signal is *absent*, not *guessed*. Absent signals are observable in the verdict — that is itself a feature.
- Do not write a partial verdict. Either the full `## Risk Score` block lands on the task and the check run lands on the PR, or neither does. Half-output is worse than no output.
- Do not edit `.maskin/protected-paths.yml`, `.maskin/risk-floors.yml`, or `.maskin/hot-tables.yml` from this skill. Those are protected paths themselves; edits are always two-human PRs.
- Do not approve, merge, or request changes. Score, output, stop. The downstream skills decide what happens next.
