#!/bin/bash
# PostToolUse hook, registered in the image's default ~/.claude/settings.json,
# that surfaces newly-relayed dev-server preview ports to Claude via
# additionalContext. Fires after every tool call and diffs
# /agent/.preview-ports.json (written by preview-port-watcher.js whenever
# agent-server relays a new port for this session) against what's already
# been reported, so a given mapping is only injected once.
#
# NOT registered on FileChanged: FileChanged is a real Claude Code hook
# event, but its hookSpecificOutput has no additionalContext carrier — that
# field is only honored by PreToolUse, PostToolUse, PostToolUseFailure,
# PermissionRequest, and UserPromptSubmit. A FileChanged-based version of
# this hook would fire correctly but its additionalContext would silently be
# discarded. PostToolUse (over PreToolUse) so this can never block or delay
# the tool call it's attached to — it only reads a small on-disk file after
# the call has already completed.
set -eo pipefail

cat >/dev/null # drain the hook's own JSON input on stdin; nothing in it is needed here

MAPPINGS_FILE="/agent/.preview-ports.json"
SEEN_FILE="/agent/.preview-ports.seen.json"
[ -f "$MAPPINGS_FILE" ] || exit 0

MAPPINGS=$(cat "$MAPPINGS_FILE")
# Guards against reading the file mid-write (preview-port-watcher.js does a
# plain truncate-and-write, not a temp+rename) — skip this invocation rather
# than erroring out; the next tool call retries against a settled file.
echo "$MAPPINGS" | jq -e . >/dev/null 2>&1 || exit 0

COUNT=$(echo "$MAPPINGS" | jq 'length' 2>/dev/null || echo 0)
[ "$COUNT" -eq 0 ] && exit 0

SEEN=$(cat "$SEEN_FILE" 2>/dev/null || echo '{}')
echo "$SEEN" | jq -e . >/dev/null 2>&1 || SEEN='{}'

# Only report mappings that are new or changed since the last time this hook
# told Claude about them — otherwise every subsequent tool call would
# re-inject the same context.
NEW=$(jq -n --argjson mappings "$MAPPINGS" --argjson seen "$SEEN" \
	'$mappings | to_entries | map(select($seen[.key] != .value))')
NEW_COUNT=$(echo "$NEW" | jq 'length')
[ "$NEW_COUNT" -eq 0 ] && exit 0

LINES=$(echo "$NEW" | jq -r '.[] | "- port \(.key) is reachable at \(.value)"')
CONTEXT="Dev server port(s) you started in this session are reachable from your own browser/Playwright tool at the URL(s) below. Use these exact URLs — not localhost, not a guessed hostname:
${LINES}"

echo "$MAPPINGS" > "$SEEN_FILE"

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
