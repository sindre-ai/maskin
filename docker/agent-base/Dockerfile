# CI: trigger automated build and deploy
FROM node:22-slim

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates openssh-client gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Pre-install pnpm (avoids corepack runtime download stalling sessions)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Pre-install Claude Code CLI (avoids npm install on every session start)
# Version is pinned because the stream-json I/O format is not stable across
# Claude Code releases — the interactive chat session parses these lines
# verbatim, so a silent CLI bump can break parsing. Bump this deliberately
# after re-validating the stream-json fixtures.
RUN npm install -g @anthropic-ai/claude-code@2.1.112

# Pre-install Playwright MCP server (connects to external browser via CDP)
RUN npm install -g @playwright/mcp

# Non-root user (Claude Code refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash agent

# Agent workspace directory structure
RUN mkdir -p /agent/skills /agent/learnings /agent/memory /agent/workspace \
    && chown -R agent:agent /agent

WORKDIR /agent/workspace

COPY entrypoint.sh /entrypoint.sh
COPY agent-run.sh /agent-run.sh
COPY github-credential-helper.sh /agent-github-credential-helper.sh
COPY cdp-retry-proxy.js /cdp-retry-proxy.js
COPY preview-port-watcher.js /preview-port-watcher.js
RUN chmod +x /entrypoint.sh /agent-run.sh /agent-github-credential-helper.sh

# PostToolUse hook that surfaces a newly-relayed dev-server preview port to
# Claude automatically — see preview-port-watcher.js (writes the mappings
# file this hook reads) and hooks/preview-ports-changed.sh (the hook
# itself; PostToolUse is used because it's the hook event that actually
# supports hookSpecificOutput.additionalContext — FileChanged does not).
# Baked into every session's default settings so no per-task configuration
# is needed for the auto-relay flow to reach the agent.
COPY hooks/preview-ports-changed.sh /agent-hooks/preview-ports-changed.sh
RUN chmod +x /agent-hooks/preview-ports-changed.sh
RUN mkdir -p /home/agent/.claude
COPY claude-settings.json /home/agent/.claude/settings.json
RUN chown -R agent:agent /home/agent/.claude

ENTRYPOINT ["/entrypoint.sh"]
