#!/bin/bash
set -e

# Detect runtime environment
# In microsandbox microVMs, /proc/cpuinfo shows the VM's virtualized CPU
# and the hostname is set by microsandbox (msb-*).
IS_MICROVM=false
if [ -f /proc/1/cmdline ] && grep -q 'sleep' /proc/1/cmdline 2>/dev/null; then
	IS_MICROVM=true
fi

# Fix bind mount permissions — entrypoint starts as root, then drops to agent user.
# In microVMs, /agent is part of the OCI image filesystem and already has correct
# ownership. Only run chown on bind-mounted paths that actually need it.
if [ "$IS_MICROVM" = true ]; then
	# In microVMs: only fix ownership if /agent is not already owned by agent
	if [ "$(stat -c %U /agent 2>/dev/null)" != "agent" ]; then
		chown -R agent:agent /agent
	fi
else
	# In Docker: always fix bind mount permissions
	chown -R agent:agent /agent
fi

mkdir -p /agent/skills /agent/learnings /agent/memory /agent/workspace
chown agent:agent /agent/skills /agent/learnings /agent/memory /agent/workspace

# Run the rest as agent user (Claude Code refuses to run as root).
# In minimal microVM images, 'su' might not be available — fall back to alternatives.
if command -v su &>/dev/null; then
	exec su agent -c 'bash /agent-run.sh'
elif command -v runuser &>/dev/null; then
	exec runuser -u agent -- bash /agent-run.sh
else
	# Last resort: use setpriv if available (util-linux), or just run directly.
	# This path should only trigger on very minimal base images.
	if command -v setpriv &>/dev/null; then
		exec setpriv --reuid=agent --regid=agent --init-groups bash /agent-run.sh
	else
		echo "[warn] Cannot drop privileges: su/runuser/setpriv not found. Running as current user." >&2
		exec bash /agent-run.sh
	fi
fi
