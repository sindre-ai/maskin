# CI: trigger automated build and deploy

# GitHub's official MCP server, pinned by tag AND digest. Bump both together,
# deliberately. The tag is a multi-arch index; the build is amd64 only
# (agent-base-docker.yml), so buildx resolves the linux/amd64 variant.
FROM ghcr.io/github/github-mcp-server:v1.13.0@sha256:15b28878c7d46edf07e16c373e48144fbeb2c5cc464e723f252677fd82a91f5f AS github-mcp

FROM node:22-slim

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates openssh-client gettext-base \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 (pinned) — used by the Infra & DevOps agent for the Agent Keychain
# Ops track (KMS, S3 Object Lock, IAM, CloudTrail). No credentials are baked in;
# the CLI does nothing until a session is given AWS_* env. unzip is installed
# only for this step and removed with the installer files. Bump the version
# deliberately. Arch is picked from uname so the build works on x86_64 and arm64.
ARG AWS_CLI_VERSION=2.37.9
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m)-${AWS_CLI_VERSION}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && apt-get purge -y unzip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && aws --version

# Pre-install pnpm (avoids corepack runtime download stalling sessions)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Pre-install Claude Code CLI (avoids npm install on every session start)
# Version is pinned because the stream-json I/O format is not stable across
# Claude Code releases — the interactive chat session parses these lines
# verbatim, so a silent CLI bump can break parsing. Bump this deliberately
# after re-validating the stream-json fixtures.
RUN npm install -g @anthropic-ai/claude-code@2.1.285

# Pre-install Playwright MCP server (connects to external browser via CDP)
RUN npm install -g @playwright/mcp

# Pre-install GitHub MCP server (static Go binary from the github-mcp stage).
# Baked in because sessions are microVMs with no Docker daemon. The --version
# run fails the image build if the binary is the wrong architecture.
COPY --from=github-mcp /server/github-mcp-server /usr/local/bin/github-mcp-server
RUN github-mcp-server --version

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
COPY input-stream.js /input-stream.js
COPY output-stream.js /output-stream.js
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

# PreToolUse hook on AskUserQuestion. The headless CLI has no TTY to render
# that tool on, so it fails the call outright; the hook redirects the question
# into the chat the agent is in instead. It is a no-op for autonomous sessions
# — see the script and POST /sessions/:id/ask for where that gate lives.
COPY hooks/ask-user-question.sh /agent-hooks/ask-user-question.sh
RUN chmod +x /agent-hooks/ask-user-question.sh

# Register workspace skills for the Claude Code harness. The harness walks
# ~/.claude/skills for SKILL.md files, but the agent-server stages workspace
# skills at /agent/skills (a mount on every dispatched session, populated by
# stageSessionSkills in the agent-server). Baking a single dir symlink at
# image build lets every session's Skill tool resolve staged skills with no
# per-session host-side work. Route decided by the spike (task bf2ab627,
# resolved 2026-09-25) — Case B, primary; the boot-time guard
# assert_skills_symlink in agent-run.sh is the check that this link is
# still present at runtime, since the spike could not verify the literal
# ~/.claude/skills path in-session (harness-write-protected).
RUN mkdir -p /home/agent/.claude \
    && ln -s /agent/skills /home/agent/.claude/skills
COPY claude-settings.json /home/agent/.claude/settings.json
RUN chown -R agent:agent /home/agent/.claude

ENTRYPOINT ["/entrypoint.sh"]
