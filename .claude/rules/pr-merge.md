# PR Merge Checklist

Before merging a PR into `main`, verify all of the following:

1. **Up to date with main**: The branch must have no commits behind `main`. Fetch and check with `git fetch origin main && git log <branch>..origin/main`. If behind, rebase or merge main into the branch first.
2. **Lint**: `pnpm lint` passes with no errors (ignore non-PR files like local settings)
3. **Type check**: `pnpm type-check` passes across all packages
4. **Tests**: `pnpm test -- -- --run` passes across all packages

All four checks must pass before merging. Do not merge with failing checks.

## Merge queue

`main` uses the GitHub merge queue. Click **Merge when ready** once the PR's own checks are green — do not rebase or re-run CI just because `main` moved.

- The queue tests the PR on a temporary `gh-readonly-queue/main/...` branch that holds the latest `main` plus any PRs ahead of it, then merges it if CI passes. That replaces the manual "up to date with main" re-check above.
- If the queue run fails, the PR is ejected: fix it and re-queue.
- Every required check in `.github/workflows/ci.yml` must also run on `merge_group`, or queued PRs stall until they time out. A new required check needs that trigger.
- Queue settings (build concurrency 5, group size 1) live in the `main` ruleset, not in the repo.
