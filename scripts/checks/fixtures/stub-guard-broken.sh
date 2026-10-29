#!/bin/bash
# A wrapper that is on the PATH but cannot run (stands in for a bad file or a
# missing node). agent-image-smoke.sh bind-mounts it over maskin-mcp-guard.
echo "stub-guard-broken: cannot run" >&2
exit 3
