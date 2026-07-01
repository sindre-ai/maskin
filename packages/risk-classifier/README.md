# @maskin/risk-classifier

Adapter binary for the `maskin/risk-classifier` workspace skill. Produces a deterministic 0–100 risk score over a PR diff plus a structured signal vector that the orchestrator skill, the GitHub check run, and Sigstore attestations all consume.

## Why a separate adapter

The skill body owns the policy (signal weights, floor rules, output format). The adapter owns the I/O — running `git`, calling `squawk` on `.sql` files, calling `semgrep` for diff scans, reading incident-density input, parsing `.maskin/*.yml`. Splitting them keeps the skill body legible and the binary unit-testable.

## Usage

```bash
# From a checkout of the repo:
pnpm --filter @maskin/risk-classifier build

node packages/risk-classifier/bin/risk-classifier.mjs \
  --base origin/main \
  --head HEAD \
  --repo .
```

Outputs the `## Risk Score` block to stdout and exits with:

| Band                     | Exit code |
| ------------------------ | --------- |
| auto                     | 0         |
| agent_recommends_human   | 1         |
| two_human_required       | 2         |

`--output json` emits the full verdict object; `--output check-run` emits the GitHub check-run summary used by the `maskin/risk-score` required check.

### Optional inputs

- `--kill-switch` — sets the score to 100 unconditionally (used by orchestrate-pr-review when the workspace kill-switch object is on)
- `--cve-dep <name@version>` — repeated; flagged dependencies considered "new with known CVE"
- `--missing-tests` — pre-computed signal: logic changes lacking corresponding test changes
- `--ai-generated` — pre-computed signal: PR carries an AI-generated marker
- `--public-api-delta <n>` — number of public API symbols added/removed in the diff
- `--incident-density <file.json>` — JSON map `{ "path": density-0-to-1 }`

## Determinism

The verdict carries a `deterministic_seed` derived from `(commit_sha, score, sorted-signal-kinds-and-weights, floors-applied, skill_version)`. Identical inputs produce an identical seed and identical score. Adapters that hit external services (`semgrep`, `squawk`, incident density) degrade to "no signal" when the underlying tool is not installed — so the binary always runs even on minimal CI runners — and that degradation is itself observable in the verdict (signal absent rather than present).

## Configuration

The adapter reads three optional YAML files at the repo root:

- `.maskin/protected-paths.yml` — path-floor patterns (any match → score 100)
- `.maskin/risk-floors.yml` — regex-floor patterns (any line match → score ≥60)
- `.maskin/hot-tables.yml` — table allowlist that promotes squawk findings

Files are owned by Task 3 of the *Auto-merge low-risk PRs* bet (`bb682faa`). When they are missing, the adapter scores from signals alone.

## Skill version

The skill's semantic version lives in [`src/types.ts`](src/types.ts) (`SKILL_VERSION`). Bump it whenever the signal table, weights, or floors change so attestations bind the verdict to the policy that produced it.
