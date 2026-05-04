# PR Merge Checklist

Before merging a PR into `main`, verify all of the following:

1. **Up to date with main**: The branch must have no commits behind `main`. Fetch and check with `git fetch origin main && git log <branch>..origin/main`. If behind, rebase or merge main into the branch first.
2. **Lint**: `pnpm lint` passes with no errors (ignore non-PR files like local settings)
3. **Type check**: `pnpm type-check` passes across all packages
4. **Tests**: `pnpm test -- -- --run` passes across all packages

All four checks must pass before merging. Do not merge with failing checks.
