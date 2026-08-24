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
RUN npm install -g @anthropic-ai/claude-code@2.1.223

# Pre-install Playwright MCP server (connects to external browser via CDP)
RUN npm install -g @playwright/mcp

# Agent SDK, used only by resolve-resume-turn.mjs to read a session transcript
# through a supported API. The on-disk JSONL format is explicitly internal and
# changes between releases, so hand-parsing it would rot silently.
RUN npm install -g @anthropic-ai/claude-agent-sdk
# resolve-resume-turn.mjs imports the SDK by bare specifier. That resolves
# because the script lives at /usr/local/lib/maskin/, so Node's walk up the
# directory tree reaches /usr/local/lib/node_modules — where `npm install -g`
# puts it on this base image. Moving the script out from under /usr/local/lib
# would break the import; keep it there, or vendor the dependency alongside it.
#
# Deliberately NOT relying on NODE_PATH: that variable is honoured only by the
# CommonJS resolver, and the script is ESM.

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
# Maps "the Nth user turn of a CLI session" to that turn's transcript uuid, so a
# rewound conversation can `claude --resume` instead of starting cold.
COPY resolve-resume-turn.mjs /usr/local/lib/maskin/resolve-resume-turn.mjs
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
