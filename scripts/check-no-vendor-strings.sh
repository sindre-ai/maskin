#!/usr/bin/env bash
# Fail if any vendor-identifying string reaches the tracked tree or this
# branch's commit history.
#
# The backend behind the tool-broker feature is a third-party service whose
# identity must not be discoverable from this repository. Source is the easy
# part; what leaks is a test fixture, an env comment, a dependency name in the
# lockfile, or a commit message written before the rule was front of mind. Git
# history cannot be scrubbed after a push, so run this before every commit and
# before opening a PR.
#
# TWO TIERS, because the vendor's bare name is also an ordinary English word and
# already occurs innocently in this repo (an agent prompt contrasts designing
# loops with being a "task <the word>"). Scanning the whole tree for it produces
# noise that would train everyone to ignore the guard:
#
#   TIER 1 — unambiguous markers (the org name, the image, the package scope,
#            the config dir, the tool namespace). Scanned across the WHOLE tree.
#            These have no innocent reading; any hit is a real leak.
#
#   TIER 2 — the bare word. Scanned only in what THIS BRANCH changes, so
#            pre-existing English usage is ignored while anything we introduce
#            is caught.
#
# Needles are assembled from fragments at runtime so this file is not itself a
# match — otherwise the guard would trip on its own source.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

V="exec""utor"
TIER1=(
	"Useful""SoftwareCo"
	"${V}"".sh"
	"integrations"".sh"
	"${V}""-selfhost"
	"host-""selfhost"
	"@""${V}""-js"
	"tools.""${V}""."
	"/.""${V}""/"
	"${V}""-data"
)
TIER2=("${V}")

SELF="scripts/$(basename "$0")"
EXCLUDE=":(exclude)$SELF"
status=0

report() {
	echo "FAIL: found '$1' $2:"
	echo "$3" | head -20
	status=1
}

echo "[1/3] Unambiguous vendor markers, whole tree..."
for needle in "${TIER1[@]}"; do
	if hits=$(git grep -I -n -i -- "$needle" -- . "$EXCLUDE" 2>/dev/null); then
		report "$needle" "in tracked files" "$hits"
	fi
done

base=$(git merge-base HEAD origin/main 2>/dev/null || echo "")

echo "[2/3] Bare vendor name, changed files only..."
if [ -n "$base" ]; then
	# Only the files this branch touches, so innocent pre-existing English usage
	# elsewhere is out of scope.
	changed=$(git diff --name-only "$base"..HEAD -- . "$EXCLUDE" 2>/dev/null)
	if [ -n "$changed" ]; then
		for needle in "${TIER2[@]}"; do
			# shellcheck disable=SC2086
			if hits=$(git grep -I -n -i -- "$needle" -- $changed 2>/dev/null); then
				report "$needle" "in a file this branch changes" "$hits"
			fi
		done
	fi
	# Uncommitted work is not in the diff above; check the working tree too.
	if hits=$(git diff --no-color -- . "$EXCLUDE"; git diff --no-color --cached -- . "$EXCLUDE") && [ -n "$hits" ]; then
		for needle in "${TIER2[@]}"; do
			if echo "$hits" | grep -q -i -- "^+.*$needle"; then
				report "$needle" "in an uncommitted change" "$(echo "$hits" | grep -i -- "^+.*$needle")"
			fi
		done
	fi
else
	echo "  (no merge-base with origin/main; skipping)"
fi

echo "[3/3] Commit messages on this branch..."
if [ -n "$base" ]; then
	for needle in "${TIER1[@]}" "${TIER2[@]}"; do
		if hits=$(git log --format='%H %s%n%b' "$base"..HEAD 2>/dev/null | grep -i -- "$needle"); then
			report "$needle" "in a commit message" "$hits"
		fi
	done
else
	echo "  (no merge-base with origin/main; skipping)"
fi

if [ "$status" -eq 0 ]; then
	echo "OK: no vendor-identifying strings found."
fi
exit "$status"
