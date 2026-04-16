# Structural Verification — File Placement & Build Config

Before committing, verify that all new files are placed in the correct directories and that build/CI configurations are complete. These are structural misses — not logic bugs — but they prevent tooling from discovering files and cause follow-up fix PRs.

## GitHub Actions Workflows

- All workflow files **MUST** be placed in `.github/workflows/` — GitHub Actions only discovers files in this directory.
- Current workflows: `.github/workflows/ci.yml` — follow its naming and structure conventions when adding new workflows.
- **NEVER** place workflow files in other directories (e.g., `docker/`, `scripts/`). Even if the workflow relates to Docker or infrastructure, it must be in `.github/workflows/`.
- Reference: PRs #223 and #236 — a GitHub Actions workflow was placed in `docker/agent-base/` instead of `.github/workflows/`, requiring two follow-up PRs to fix.

## Build Files

- Each app in `apps/` that has a `build` script in its `package.json` **MUST** have the corresponding build file (e.g., `build.mjs`) checked into the repo.
- When creating a new app or adding build steps:
  1. Verify the build file exists at the path referenced in `package.json`
  2. Verify `turbo.json` at the repo root includes the build task in its pipeline
  3. Run `pnpm build` to confirm no build files are missing
- Reference: PR #216 — a missing `build.mjs` broke the build pipeline.

## Monorepo Structure Conventions

| Directory | Purpose | Examples |
|-----------|---------|---------|
| `apps/` | Deployable services | `apps/dev` (backend API), `apps/web` (frontend), `apps/e2e` (E2E tests) |
| `packages/` | Shared libraries | `packages/shared`, `packages/db`, `packages/mcp`, `packages/realtime`, `packages/storage`, `packages/auth`, `packages/module-sdk` |
| `.claude/agents/` | Agent definitions | Agent config files |
| `.claude/rules/` | Rules for Claude Code | This file, `testing.md`, `pre-commit.md`, etc. |
| `docker/` | Dockerfiles and support scripts only | **NOT** for CI/workflow files |
| `.github/workflows/` | CI/CD workflows | `ci.yml` |

## Environment Variables in Turbo

When adding new environment variables used at runtime:
- Add them to the `globalPassThroughEnv` array in `turbo.json`
- Turbo filters env vars — unlisted ones are **silently unavailable** to dev/build tasks even if set in `.env`
- This is especially easy to miss for integration provider credentials (see `.claude/rules/integrations.md`)

## Pre-Submission Structural Checklist

Before committing, verify:

1. **File placement** — Any new files are in the correct directory per the conventions above
2. **Build files** — If you created or modified a build file, it's referenced in the corresponding `package.json` and runs successfully
3. **Workflow files** — If you created a workflow file, it's in `.github/workflows/`
4. **Environment variables** — If you added a new env var, it's listed in `turbo.json` `globalPassThroughEnv`
5. **Build passes** — Run `pnpm build` to verify no build files are missing and the pipeline completes
