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
# GitHub MCP proxy that mints a fresh narrowed installation token per
# `tools/call` (parent bet AC #3 for the API-side surface). Kept alongside
# the credential helper — same "hit the mint route from the container"
# pattern, different transport. session-manager spawns it via `node`.
COPY github-mcp-proxy.mjs /agent-github-mcp-proxy.mjs
# The lib is COPY'd unprefixed because the proxy's ES module import is
# `./github-mcp-proxy-lib.mjs` — Node resolves that relative to the proxy's
# directory (`/`), so the file must land at `/github-mcp-proxy-lib.mjs`.
# Renaming it to `/agent-github-mcp-proxy-lib.mjs` here breaks the import.
COPY github-mcp-proxy-lib.mjs /github-mcp-proxy-lib.mjs
RUN chmod +x /entrypoint.sh /agent-run.sh /agent-github-credential-helper.sh /agent-github-mcp-proxy.mjs

ENTRYPOINT ["/entrypoint.sh"]
