# Contributing to Maskin

Thanks for considering a contribution. Maskin is an open-source AI agent workspace and we take PRs of all sizes — bug reports, docs, templates, integrations, and features.

## Getting set up

```bash
git clone https://github.com/sindre-ai/maskin.git
cd maskin
pnpm install
pnpm dev            # macOS / Linux (docker compose up works too)
pnpm dev:win        # Windows
```

See [CLAUDE.md](CLAUDE.md) for the detailed onboarding walkthrough — including how to wire Maskin into Claude Code via MCP.

## Before you open a PR

Run the pre-commit checks. All three must pass:

```bash
pnpm lint
pnpm type-check
pnpm test -- --run
```

For changes that touch route handlers, DB triggers, or shell command construction, also review `.claude/rules/input-validation.md` and `.claude/rules/known-pitfalls.md`.

## PR conventions

- One logical change per PR. Split unrelated refactors into follow-ups.
- Include a short description of *why*, not just *what*.
- Link the issue you're closing with `Closes #NNN` when applicable.
- Add tests for new behavior — see `.claude/rules/testing.md` for locations and patterns.

Before merging, the PR must also be up to date with `main` and pass the full checks suite (see `.claude/rules/pr-merge.md`).

## Good first issues

Look for issues labeled [`good first issue`](https://github.com/sindre-ai/maskin/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). They're scoped to be tractable without deep repo context.

## Reporting bugs

Open an issue using the bug report template in [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/). Include the minimum reproduction, what you expected, and what happened.

## Security

Please do not open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 license](LICENSE).
