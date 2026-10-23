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
| human_review_required    | 2         |

`--output json` emits the full verdict object; `--output check-run` emits the GitHub check-run summary used by the `maskin/risk-score` required check.

### Optional inputs

- `--cve-dep <name@version>` — repeated; flagged dependencies considered "new with known CVE"
- `--missing-tests` — pre-computed signal: logic changes lacking corresponding test changes
- `--ai-generated` — pre-computed signal: PR carries an AI-generated marker
- `--public-api-delta <n>` — number of public API symbols added/removed in the diff
- `--incident-density <file.json>` — JSON map `{ "path": density-0-to-1 }`

## Determinism

The verdict carries a `deterministic_seed` derived from `(commit_sha, score, sorted-signal-kinds-and-weights, floors-applied, skill_version)`. Identical inputs produce an identical seed and identical score. Adapters that hit external services (`semgrep`, `squawk`, incident density) degrade to "no signal" when the underlying tool is not installed — so the binary always runs even on minimal CI runners — and that degradation is itself observable in the verdict (signal absent rather than present).

## What blocks a PR

A PR needs a person (`human_review_required`) only when it trips one of these. Size does not: total lines changed is a note in the output, never a gate. Generated files (lock files, the OpenAPI snapshot and Apple client, drizzle snapshots; see `src/lib/generated.ts`) are not counted and not gated.

1. **A critical path.** Any changed file matching `.maskin/protected-paths.yml` (auth, secrets and encryption, billing, the Keychain, CI workflows, deploy config, agent rulebooks, `.maskin` itself).
2. **A migration that touches a core table.** Any `.sql` file under `packages/db` with a statement that alters, updates, deletes from, inserts into, or creates an index or trigger on a table in `.maskin/core-tables.yml`, or a function, trigger or DO block that mentions one. A migration that only creates new tables and their own indexes and constraints (foreign keys to a core table included) is not gated. `packages/db/src/schema.ts` is judged through its migration, not by itself.
3. **Always, whatever the table:** DROP, TRUNCATE, grants and revokes, roles, row level security and policies, and functions or DO blocks that run dynamic SQL. In a rollback script under `drizzle/down/` a DROP of a non-core object is expected and not gated.
4. **SQL it cannot read.** Unterminated quotes or comments, unbalanced parentheses, a statement type it does not know, an existing migration that was edited (the diff holds only part of the file), or a file whose SQL is not in the diff. Never treated as fine.

Each gate carries the file and the table or path that tripped it, and both the `## Risk Score` block and the check-run summary list them.

## Configuration

The adapter reads four YAML files at the repo root — see the files themselves for the exact schema and rationale for each entry:

- [`.maskin/protected-paths.yml`](../../.maskin/protected-paths.yml) — critical paths (any match → score 100)
- [`.maskin/core-tables.yml`](../../.maskin/core-tables.yml) — the core tables the migration gate protects
- [`.maskin/risk-floors.yml`](../../.maskin/risk-floors.yml) — regex-floor patterns (any line match → score ≥80)
- [`.maskin/hot-tables.yml`](../../.maskin/hot-tables.yml) — table allowlist that promotes squawk findings

`loadMaskinConfig` (used by `bin/risk-classifier.mjs`) degrades a missing file to an empty floor so a scoring run always produces a verdict. That tolerance is intentional for the scorer, but a floor silently going empty is exactly the R4 gap the `risk-gate` skill calls out — so CI checks separately, with a hard failure instead of a silent degrade:

```bash
node packages/risk-classifier/bin/assert-risk-config.mjs --repo .
```

Exits `0` when all four files exist and match their schema; exits `1` with a per-file reason on stderr otherwise. Wired into `.github/workflows/risk-score.yml`, which runs ahead of the scoring step on every PR into `main` or a `bet/**` branch.

## Skill version

The skill's semantic version lives in [`src/types.ts`](src/types.ts) (`SKILL_VERSION`). Bump it whenever the signal table, weights, or floors change so attestations bind the verdict to the policy that produced it.
