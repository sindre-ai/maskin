#!/usr/bin/env bash
# Table test for changed-areas.sh. Run: bash scripts/ci/changed-areas.test.sh
set -euo pipefail
cd "$(dirname "$0")"

fail=0
check() {
	local name="$1" expected="$2" files="$3" got
	got=$(printf '%s' "$files" | bash ./changed-areas.sh | tr '\n' ' ')
	if [ "$got" != "$expected" ]; then
		echo "FAIL $name: expected '$expected' got '$got'"
		fail=1
	fi
}

check "empty diff runs everything" "backend=true e2e=true " ""
check "docs only" "backend=false e2e=false " $'README.md\ndocs/reference/x.md\n.claude/rules/a.md'
check "apple only" "backend=false e2e=false " $'apps/apple/App/View.swift'
check "web only skips integration" "backend=false e2e=true " $'apps/web/src/a.tsx'
check "e2e specs only skip integration" "backend=false e2e=true " $'apps/e2e/src/tests/a.spec.ts'
check "backend code runs both" "backend=true e2e=true " $'apps/dev/src/routes/a.ts'
check "shared package runs both" "backend=true e2e=true " $'packages/shared/src/a.ts'
check "lockfile runs both" "backend=true e2e=true " $'pnpm-lock.yaml'
check "ci.yml runs both" "backend=true e2e=true " $'.github/workflows/ci.yml'
check "unknown path runs both" "backend=true e2e=true " $'something/new.txt'
check "one real file among docs runs" "backend=true e2e=true " $'README.md\napps/dev/src/a.ts'
check "web plus docs" "backend=false e2e=true " $'docs/a.md\napps/web/src/a.tsx'

[ "$fail" = 0 ] && echo "changed-areas: all cases pass"
exit "$fail"
