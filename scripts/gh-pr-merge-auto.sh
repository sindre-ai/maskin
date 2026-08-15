#!/usr/bin/env bash
# gh-pr-merge-auto.sh — arm GitHub-native auto-merge for a PR, with a single retry on transient 5xx.
#
# Usage: scripts/gh-pr-merge-auto.sh <PR_URL_OR_NUMBER> [extra gh args...]
#
# Wraps `gh pr merge <PR> --auto --squash`. GitHub's `enablePullRequestAutoMerge`
# mutation is idempotent (cli/cli#13345), so a single retry on 5xx is safe.
# Anything other than 5xx (401, 403, mergeable-blocked, etc.) is deterministic
# and passes through unchanged so downstream classification stays honest —
# retrying an auth failure would just delay the same error.
#
# Env knobs (mostly for tests):
#   GH_BIN                — path to the gh binary (default: gh)
#   GH_MERGE_RETRY_DELAY  — seconds to sleep before the retry (default: 5)

set -uo pipefail

if [[ $# -lt 1 ]]; then
	echo "usage: gh-pr-merge-auto.sh <PR_URL_OR_NUMBER> [extra gh args...]" >&2
	exit 2
fi

PR="$1"
shift

: "${GH_BIN:=gh}"
: "${GH_MERGE_RETRY_DELAY:=5}"

STDERR_FILE=$(mktemp)
trap 'rm -f "$STDERR_FILE"' EXIT

# Only 5xx from the upstream API is retryable — everything else is a
# determined verdict (bad auth, protection block, malformed PR).
is_transient_5xx() {
	grep -Eq 'HTTP 5[0-9]{2}|(^|[^0-9])(500|502|503|504)([^0-9]|$)|Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error' "$STDERR_FILE"
}

"$GH_BIN" pr merge "$PR" --auto --squash "$@" 2>"$STDERR_FILE"
STATUS=$?
cat "$STDERR_FILE" >&2

if [[ $STATUS -eq 0 ]]; then
	exit 0
fi

if ! is_transient_5xx; then
	exit "$STATUS"
fi

echo "gh-pr-merge-auto: transient 5xx on first attempt, retrying in ${GH_MERGE_RETRY_DELAY}s" >&2
sleep "$GH_MERGE_RETRY_DELAY"

: >"$STDERR_FILE"
"$GH_BIN" pr merge "$PR" --auto --squash "$@" 2>"$STDERR_FILE"
STATUS=$?
cat "$STDERR_FILE" >&2
exit "$STATUS"
