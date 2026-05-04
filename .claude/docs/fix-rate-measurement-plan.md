# Code Reviewer Fix Rate — Measurement Plan

## Verification Report (2026-04-16)

All guidelines from the "Harden Senior Developer guidelines" bet have been verified as correctly deployed to `main`.

### Files verified

| Check | File | Status |
|-------|------|--------|
| Input validation rules | `.claude/rules/input-validation.md` | Present |
| Structural verification rules | `.claude/rules/structural-verification.md` | Present |
| Known pitfalls registry | `.claude/rules/known-pitfalls.md` | Present |
| CLAUDE.md — Project Rules section | `CLAUDE.md` lists all three new rules files | Present |
| CLAUDE.md — Code Conventions section | `CLAUDE.md` mentions input validation and PG NOTIFY 8KB limit | Present |
| PreToolUse hook — backend routes | `.claude/settings.json` hook for `apps/dev/src/routes/` | Present |
| PreToolUse hook — migrations | `.claude/settings.json` hook for `packages/db/` | Present |
| PreToolUse hook — backend services | `.claude/settings.json` hook for `apps/dev/src/services/` | Present |
| Pre-commit checklist — input validation | `.claude/rules/pre-commit.md` step 4 | Present |
| Pre-commit checklist — structural verification | `.claude/rules/pre-commit.md` step 5 | Present |

### PRs that delivered these changes

| Task | PR |
|------|----|
| 1. Input validation rules | [#249](https://github.com/sindre-ai/maskin/pull/249) |
| 2. Structural verification rules | [#250](https://github.com/sindre-ai/maskin/pull/250) |
| 3. Known pitfalls registry | [#251](https://github.com/sindre-ai/maskin/pull/251) |
| 4. CLAUDE.md references | [#252](https://github.com/sindre-ai/maskin/pull/252) |
| 5. PreToolUse hooks | [#253](https://github.com/sindre-ai/maskin/pull/253) |
| 6. Pre-commit checklist updates | [#254](https://github.com/sindre-ai/maskin/pull/254) |

---

## Measurement Plan

### Baseline

- **Fix rate**: 35% (7 fixes out of 20 PRs reviewed)
- **Source**: Insight `70f11891`, measured Apr 11–12, 2026
- **Categories observed**: Input validation gaps (3 in 48h), structural/config misses (3 in 48h)

### Target

- **Fix rate**: Under 20%
- **Stretch goal**: Under 15% (would indicate systemic improvement beyond the two targeted categories)

### Measurement period

- **Start**: 2026-04-16 (date these guidelines shipped to `main`)
- **Duration**: ~2 weeks (one sprint), or until 20+ PRs have been reviewed under the new guidelines — whichever comes later
- **End (estimated)**: 2026-04-30

### How to measure

The `workspace_observer` agent already tracks Code Reviewer sessions and generates insights on fix rates. After the measurement period:

1. **Collect all Code Reviewer sessions** that started on or after 2026-04-16
2. **Count total PRs reviewed** vs. **PRs that required fixes** (any request_changes review or follow-up commit prompted by reviewer feedback)
3. **Calculate fix rate**: `(PRs with fixes / total PRs reviewed) × 100`
4. **Compare** to the 35% baseline

### Categories to track separately

To understand which guidelines had the most impact, break down fixes into:

| Category | What to look for | Targeted by |
|----------|-----------------|-------------|
| **Input validation** | Missing param validation, NaN propagation, shell injection, PG NOTIFY payload size | `input-validation.md`, `known-pitfalls.md`, route/service hooks |
| **Structural/config** | Wrong file placement, missing build files, missing env vars in turbo.json | `structural-verification.md`, pre-commit step 5 |
| **Other** | All other fix categories (logic bugs, style issues, test gaps, etc.) | Not specifically targeted by this bet |

### Success criteria

- **Primary**: Overall fix rate drops below 20% over 20+ PRs
- **Secondary**: Input validation and structural/config fix categories each drop to near-zero (these were specifically targeted)
- **If fix rate stays above 20%**: Analyze which categories are still causing fixes and consider a follow-up bet targeting those categories
