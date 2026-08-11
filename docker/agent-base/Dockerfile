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

# Pre-install mcp-remote so the tool-invocation emitter (below) does not have
# to hit the npm registry on the first tool call of every session — a cold
# `npx -y mcp-remote` install adds seconds to that call and can time out
# behind restrictive egress.
RUN npm install -g mcp-remote@0.1.29

# Non-root user (Claude Code refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash agent

# Agent workspace directory structure
RUN mkdir -p /agent/skills /agent/learnings /agent/memory /agent/workspace \
    && chown -R agent:agent /agent

WORKDIR /agent/workspace

COPY entrypoint.sh /entrypoint.sh
COPY agent-run.sh /agent-run.sh
COPY github-credential-helper.sh /agent-github-credential-helper.sh
COPY mcp-tool-invocation-emitter.mjs /opt/maskin/mcp-tool-invocation-emitter.mjs
RUN chmod +x /entrypoint.sh /agent-run.sh /agent-github-credential-helper.sh /opt/maskin/mcp-tool-invocation-emitter.mjs

ENTRYPOINT ["/entrypoint.sh"]
