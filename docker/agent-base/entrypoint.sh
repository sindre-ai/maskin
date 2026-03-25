#!/bin/bash
set -e

# Fix bind mount permissions — entrypoint starts as root, then drops to agent user
chown -R agent:agent /agent
mkdir -p /agent/skills /agent/learnings /agent/memory /agent/workspace
chown -R agent:agent /agent

# Run the rest as agent user (Claude Code refuses to run as root)
exec su agent -c 'bash /agent-run.sh'
