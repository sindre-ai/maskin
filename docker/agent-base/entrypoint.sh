#!/bin/bash
set -e

# Fix bind mount permissions — entrypoint starts as root, then drops to agent user
chown -R agent:agent /agent
mkdir -p /agent/skills /agent/learnings /agent/memory /agent/workspace
chown -R agent:agent /agent

# microsandbox's TCP proxy (allow@host:tcp:PORT) is only active during msb exec
# sessions, not during the VM's create-time boot. This entrypoint is called twice:
#   1. Create-time (no proxy): no trigger file — sleep forever, wait for exec.
#   2. Exec-time (proxy active): trigger file written by agent-server — run workload.
# The agent-server writes .exec-trigger to the bind-mounted /agent dir right after
# msb create completes, then calls msb exec to enter path 2.
if [ ! -f /agent/.exec-trigger ]; then
    exec sleep infinity
fi

exec su agent -c 'bash /agent-run.sh'
