#!/bin/bash
set -e

# Fix bind mount permissions — entrypoint starts as root, then the agent-server runs
# the agent as the `agent` user via `msb exec -u agent`. chown is best-effort: some
# bind-mount backends reject chown ("Operation not permitted"), which must NOT kill
# boot, so it's guarded with `|| true`.
mkdir -p /agent/skills /agent/learnings /agent/memory /agent/workspace
chown -R agent:agent /agent 2>/dev/null || true

# Do NOT run the agent here. The agent-server starts it as the agentd "primary
# session" via `msb exec -u agent <sid> -- bash /agent-run.sh`, so its stdout/stderr
# are captured on the host through `msb logs` (the reliable agentd channel) instead
# of the broken VM->host TCP egress. Here we just keep the microVM alive and idle.
exec sleep infinity
