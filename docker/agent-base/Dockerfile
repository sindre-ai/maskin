# syntax=docker/dockerfile:1.7
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

# Pre-fetched repos used by Developer-agent sessions. Each is checked out at a
# pinned SHA passed by CI and has its dependencies installed at image-build
# time, so a session that clones the same repo and runs
# `pnpm install --frozen-lockfile` resolves every package from the populated
# pnpm CAS store at /home/agent/.local/share/pnpm/store with zero network
# downloads. The session's clone need NOT live at this path — pnpm's store is
# host-global per user, so a fresh clone anywhere on the filesystem benefits.
#
# Layout (all owned by the `agent` user):
#   /opt/agent-prefetch/maskin   — sindre-ai/maskin at $MASKIN_REF + node_modules
#   /opt/agent-prefetch/skjald   — sindre-ai/skjald at $SKJALD_REF + node_modules
#   /home/agent/.local/share/pnpm/store  — populated CAS store
#
# Refresh contract: T4 (CI rebuild on lockfile bump) re-builds this image
# whenever either repo's pnpm-lock.yaml changes on main, so the baked store
# does not drift from the lockfile a session resolves against.
ARG MASKIN_REPO=sindre-ai/maskin
ARG MASKIN_REF=main
ARG SKJALD_REPO=sindre-ai/skjald
ARG SKJALD_REF=main

RUN mkdir -p /opt/agent-prefetch \
    && chown -R agent:agent /opt/agent-prefetch

USER agent
WORKDIR /opt/agent-prefetch

# The GitHub token is consumed via a BuildKit secret mount so it never lands
# in any image layer or in `.git/config`. The remote URL is rewritten back to
# the plain https form after clone for the same reason.
#
# `git fetch` by SHA depends on the remote allowing reachable-SHA fetches —
# GitHub does, so we shallow-clone the default branch first to set up refs and
# then fetch the exact pinned SHA.
#
# The secret-file scrub runs in this same RUN — before the layer is committed
# — so any `.env*`/`*.pem`/`*.key` an upstream repo may have committed never
# enters the image. Doing this in a later RUN would only hide the bytes at
# the squashed filesystem level; the lower layer (downloadable from the
# registry) would still carry them.
RUN --mount=type=secret,id=github_token,uid=1000,mode=0400 \
    set -eu; \
    token="$(cat /run/secrets/github_token 2>/dev/null || true)"; \
    auth_host="github.com"; \
    if [ -n "$token" ]; then \
      auth_host="x-access-token:${token}@github.com"; \
    fi; \
    # Entries are `<dir>:<owner/repo>:<ref>`. The repo segment may contain a
    # slash but never a colon; refs are pinned SHAs which also never contain a
    # colon — so `${rest%:*}` (repo) and `${rest##*:}` (ref) split cleanly.
    for entry in "maskin:${MASKIN_REPO}:${MASKIN_REF}" "skjald:${SKJALD_REPO}:${SKJALD_REF}"; do \
      dir="${entry%%:*}"; rest="${entry#*:}"; \
      repo="${rest%:*}"; ref="${rest##*:}"; \
      echo "[prefetch] cloning ${repo}@${ref} -> /opt/agent-prefetch/${dir}"; \
      git clone --depth 1 "https://${auth_host}/${repo}.git" "${dir}"; \
      ( cd "${dir}" \
        && git fetch --depth 1 origin "${ref}" \
        && git checkout --detach FETCH_HEAD \
        && git remote set-url origin "https://github.com/${repo}.git" ); \
    done; \
    echo "[prefetch] scrubbing any committed .env / key files before layer commit"; \
    find /opt/agent-prefetch \
      \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) \
      -type f -print -delete || true

# Install deps with a frozen lockfile so the pnpm CAS store + node_modules
# match the lockfile that a session will resolve against. `pnpm install` is
# run as the `agent` user so the store lands under /home/agent and is
# directly reusable by sessions running as the same user.
RUN set -eu; \
    for dir in maskin skjald; do \
      echo "[prefetch] pnpm install --frozen-lockfile in ${dir}"; \
      ( cd "/opt/agent-prefetch/${dir}" && pnpm install --frozen-lockfile ); \
    done

USER root

WORKDIR /agent/workspace

COPY entrypoint.sh /entrypoint.sh
COPY agent-run.sh /agent-run.sh
RUN chmod +x /entrypoint.sh /agent-run.sh

ENTRYPOINT ["/entrypoint.sh"]
