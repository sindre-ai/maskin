# Pre-Commit Checklist

Before running `git commit`, always run these three checks and fix any failures:

1. **Lint**: `pnpm lint`
2. **Type check**: `pnpm type-check`
3. **Tests**: `pnpm test -- --run`
4. **Input validation review**: If your changes include route handlers, middleware, DB triggers, or shell command construction:
   - Verify all external inputs are validated (see `.claude/rules/input-validation.md`)
   - Check against known pitfalls (see `.claude/rules/known-pitfalls.md`)
5. **Structural verification**: If your changes include new files:
   - Verify files are in the correct directories (see `.claude/rules/structural-verification.md`)
   - Run `pnpm build` to confirm no build files are missing
   - If you added env vars, confirm they're in `turbo.json` `globalPassThroughEnv`

If any check fails, fix the issue before committing. Never use `--no-verify` to skip checks.
