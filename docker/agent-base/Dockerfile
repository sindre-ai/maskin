FROM node:20-slim

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates openssh-client gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Claude Code CLI (avoids npm install on every session start)
# Version is pinned because the stream-json I/O format is not stable across
# Claude Code releases — the interactive Sindre session parses these lines
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
RUN chmod +x /entrypoint.sh /agent-run.sh

ENTRYPOINT ["/entrypoint.sh"]
