#!/usr/bin/env bash
# Fast developer-facing probe: any string equal to 'completed' / 'failed' /
# 'timeout' / 'user_stopped' / 'paused' assigned to a `status` property anywhere
# under `apps/dev/src/**/*.ts` — except session-lifecycle.ts, test files, and
# `__tests__/` — is an offender. Exit non-zero on any hit.
#
# Vitest (apps/dev/src/services/session-lifecycle.guard.test.ts) is the
# authoritative check: it runs on every PR via `pnpm test` and uses ts-morph so
# it doesn't false-positive on log strings or property names that happen to be
# called `status`. This script is a second, faster probe that also catches raw
# SQL migrations or dynamic writes the AST scan might miss.

set -euo pipefail

# Fail loudly if ripgrep isn't on PATH — a silent success here would let a
# developer think the guard passed when nothing was actually scanned.
command -v rg >/dev/null || {
  echo "guard-terminal-status.sh: ripgrep (rg) not on PATH; install it or run the authoritative vitest guard instead:" >&2
  echo "  pnpm --filter @maskin/dev exec vitest run src/services/session-lifecycle.guard.test.ts" >&2
  exit 2
}

BAD=$(rg -n --type ts \
  -g '!apps/dev/src/services/session-lifecycle.ts' \
  -g '!**/*.test.ts' \
  -g '!**/__tests__/**' \
  "status:\s*['\"](completed|failed|timeout|user_stopped|paused)['\"]" \
  apps/dev/src || true)
[[ -z "$BAD" ]] || { echo "$BAD" >&2; exit 1; }
