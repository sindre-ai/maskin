#!/bin/bash
# FileChanged hook, registered in the image's default ~/.claude/settings.json
# to watch /agent/.preview-ports.json (see preview-port-watcher.js, which
# writes that file whenever agent-server relays a new dev-server port for
# this session). Fires automatically when the file changes — no polling or
# file-checking needed on Claude's part.
set -eo pipefail

cat >/dev/null # drain the hook's own JSON input on stdin; nothing in it is needed here

MAPPINGS_FILE="/agent/workspace/.preview-ports.json"
[ -f "$MAPPINGS_FILE" ] || exit 0

MAPPINGS=$(cat "$MAPPINGS_FILE")
COUNT=$(echo "$MAPPINGS" | jq 'length' 2>/dev/null || echo 0)
[ "$COUNT" -eq 0 ] && exit 0

LINES=$(echo "$MAPPINGS" | jq -r 'to_entries[] | "- port \(.key) is reachable at \(.value)"')
CONTEXT="Dev server port(s) you started in this session are reachable from your own browser/Playwright tool at the URL(s) below. Use these exact URLs — not localhost, not a guessed hostname:
${LINES}"

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput: {hookEventName: "FileChanged", additionalContext: $ctx}}'
