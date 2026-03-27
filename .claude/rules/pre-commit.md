# Pre-Commit Checklist

Before running `git commit`, always run these three checks and fix any failures:

1. **Lint**: `pnpm lint`
2. **Type check**: `pnpm type-check`
3. **Tests**: `pnpm test -- --run`

If any check fails, fix the issue before committing. Never use `--no-verify` to skip checks.
