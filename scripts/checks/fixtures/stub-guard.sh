#!/bin/bash
# Stand-in for the maskin-mcp-guard wrapper that answers --version, bind-mounted
# over /usr/local/bin/maskin-mcp-guard by scripts/checks/agent-image-smoke.sh.
# It lets the launch-script cases run without the real wrapper source.
[ "${1:-}" = "--version" ] && echo "0.0.0-stub" && exit 0
echo "stub-guard: only --version is implemented" >&2
exit 2
