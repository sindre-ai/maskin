#!/usr/bin/env bash
# Decides which expensive CI jobs a change can affect.
#
# Reads changed file paths on stdin (one per line) and prints, for $GITHUB_OUTPUT:
#   backend=true|false   integration tests (apps/dev against real Postgres)
#   e2e=true|false       Playwright specs (whole stack: web + dev + db)
#
# The rule is deliberately conservative: a path is only allowed to skip a job when it is
# listed below as unable to affect it. Anything unknown, and an empty list (the diff could
# not be computed), runs everything. Unit tests and lint are cheap and always run.
#
# Pure so it can be tested: scripts/ci/changed-areas.test.sh.
set -euo pipefail

backend=false
e2e=false
seen=false

while IFS= read -r path || [ -n "$path" ]; do
	[ -z "$path" ] && continue
	seen=true
	case "$path" in
	# Cannot affect either suite: docs, other apps with their own workflows, repo chores.
	*.md | docs/* | observability/* | apps/apple/* | bet-notes/* | .claude/* | LICENSE | \
		.github/ISSUE_TEMPLATE/* | .github/workflows/agent-*.yml | .github/workflows/apple.yml | \
		.github/workflows/desktop-docker.yml | docker/agent-base/* | docker/desktop/*)
		;;
	# The frontend and the specs themselves: integration tests never load them.
	apps/web/* | apps/e2e/*)
		e2e=true
		;;
	# Everything else (apps/dev, packages/*, lockfile, turbo.json, ci.yml, ...) can affect both.
	*)
		backend=true
		e2e=true
		;;
	esac
done

if [ "$seen" = false ]; then
	backend=true
	e2e=true
fi

echo "backend=$backend"
echo "e2e=$e2e"
