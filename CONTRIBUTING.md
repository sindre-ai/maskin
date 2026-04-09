# Contributing to Maskin

Thanks for your interest in contributing to Maskin! This guide will help you get started.

## Getting Started

1. **Fork the repository** and clone your fork
2. **Install dependencies**: `pnpm install` (requires Node.js >= 20 and pnpm 9.15.0)
3. **Start the dev environment**: `pnpm dev` (starts PostgreSQL, SeaweedFS, and all services)
4. **Open the app**: `http://localhost:5173`

## Development Workflow

1. Create a branch from `main` (`feat/your-feature` or `fix/your-fix`)
2. Make your changes
3. Run checks before committing:
   ```bash
   pnpm lint
   pnpm type-check
   pnpm test -- --run
   ```
4. Commit with a clear message describing the change
5. Push your branch and open a pull request against `main`

## Code Style

- **Biome** handles linting and formatting — run `pnpm lint:fix` to auto-fix issues
- Tab indentation, single quotes, semicolons as-needed
- All validation uses **Zod** schemas in `packages/shared/src/schemas/`
- Database access via **Drizzle ORM** — no raw SQL

## Project Structure

```
apps/
  dev/          # Backend API (Hono.js + Drizzle + PostgreSQL)
  web/          # Frontend (Vite + React 19 + TanStack Router)
  e2e/          # End-to-end tests (Playwright)
packages/
  shared/       # Shared schemas, types, and utilities
  mcp/          # MCP server (stdio + HTTP transport)
  realtime/     # PG NOTIFY -> SSE bridge
  storage/      # S3-compatible storage abstraction
docker/         # Docker configurations for agent sessions
extensions/     # Built-in extensions
```

## Testing

| Scope | Command |
|-------|---------|
| All unit tests | `pnpm test -- --run` |
| Integration tests | `pnpm test:integration -- --run` |
| E2E tests | `pnpm test:e2e` |
| Single test file | `cd apps/dev && pnpm vitest run src/__tests__/path/to/test.ts` |

See `.claude/rules/testing.md` for detailed testing conventions.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Ensure all CI checks pass (lint, type-check, build, tests)
- Add tests for new functionality
- Update documentation if your change affects the public API

## Reporting Bugs

Use the [bug report template](https://github.com/sindre-ai/maskin/issues/new?template=bug_report.yml) to report bugs.

## Security

If you discover a security vulnerability, please follow the process in [SECURITY.md](SECURITY.md). Do **not** open a public issue for security vulnerabilities.

## License

By contributing to Maskin, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
