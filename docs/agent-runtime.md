# Agent Runtime Environment

This document describes the container environment that agent sessions run in. Read this before authoring an actor's `system_prompt` so the model doesn't waste session time discovering what's available.

## Base image

Agent sessions execute inside the image defined in [`docker/agent-base/Dockerfile`](../docker/agent-base/Dockerfile):

- `node:20-slim` (Debian slim with Node.js 20)
- Non-root `agent` user, `WORKDIR=/agent/workspace`
- Workspace layout: `/agent/skills`, `/agent/learnings`, `/agent/memory`, `/agent/workspace`

## Pre-installed tooling

Available out of the box, no install step needed:

- **Node.js 20** — `node`, `npm`, `npx`
- **Claude Code CLI** — `claude` (pinned, see Dockerfile for version)
- **Playwright MCP** — `@playwright/mcp` (global)
- **Shell utilities** — `git`, `curl`, `jq`, `ca-certificates`, `openssh-client`, `gettext-base` (`envsubst`)

## Not installed

These are commonly assumed to be present and **are not**:

- ❌ **Python / `python` / `python3`**
- ❌ **`pip` / `pip3`**
- ❌ Compilers (`gcc`, `make`)
- ❌ Other language runtimes (Ruby, Go, Java, etc.)

If your actor's prompt instructs the model to run `pip install <pkg>` or `python <script>`, the command will fail with `command not found`. Worse, the model often won't give up — it will spend the rest of its budget chasing alternatives and the session will time out.

## Recommended patterns

**Need a tool that's normally a Python package?** Prefer in this order:

1. A pre-built static binary downloaded with `curl` to `/agent/workspace/`. Example for `yt-dlp`:
   ```bash
   curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
     -o /agent/workspace/yt-dlp \
     && chmod +x /agent/workspace/yt-dlp
   ```
2. An equivalent npm package (`npm install <pkg>` works in `/agent/workspace`).
3. A direct HTTP API call with `curl` + `jq` or `node -e`.

**Tell the model up-front in the system prompt** what runtime constraints apply. Don't rely on the model to discover them inside its session budget.

## Why these constraints

The base image is intentionally small to keep cold starts fast and the attack surface narrow. Adding language runtimes would slow every session start for every actor — the cost is paid by all sessions, not just the ones that need Python. If an actor genuinely needs a different runtime, the better path is a custom Docker image (see `AGENT_RUNTIME=custom` in `agent-run.sh`) rather than fattening the base.

## Reference

Source: [`docker/agent-base/Dockerfile`](../docker/agent-base/Dockerfile), [`docker/agent-base/agent-run.sh`](../docker/agent-base/agent-run.sh).
