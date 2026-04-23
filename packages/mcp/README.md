# @maskin/mcp

> Connect Claude, Cursor, Cline, and any MCP client to a [Maskin](https://github.com/sindre-ai/maskin) workspace in 2 minutes.

`@maskin/mcp` is the official [Model Context Protocol](https://modelcontextprotocol.io) server for Maskin. It exposes 39 tools that let any MCP-compatible AI client read and write objects (insights, bets, tasks, custom types), manage relationships, run agents, fire triggers, browse events, and configure workspaces — all over a Maskin instance you point it at.

- **Stdio transport** — runs as a local subprocess from your MCP client (`npx -y @maskin/mcp`).
- **HTTP transport** — also embedded directly in the Maskin server at `POST /mcp` for hosted setups.
- **Same auth as the rest of Maskin** — API key + workspace ID, nothing else to configure.

## Install in 2 minutes

You need a running Maskin instance and an API key. The quickest way to get one:

```bash
git clone https://github.com/sindre-ai/maskin && cd maskin
pnpm install && pnpm dev
```

The dev server prints a copy-pasteable `claude mcp add` command on startup with a real API key and workspace ID. Use the values from that banner in the configs below.

If you already have a Maskin instance, grab your API key from **Settings → API keys** and your workspace ID from the URL.

## Connect from your MCP client

All examples use three environment variables:

| Variable | Required | Default |
|---|---|---|
| `API_BASE_URL` | yes | `http://localhost:3000` |
| `API_KEY` | yes | — |
| `WORKSPACE_ID` | yes | — |

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "maskin": {
      "command": "npx",
      "args": ["-y", "@maskin/mcp"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "API_KEY": "ank_your_api_key_here",
        "WORKSPACE_ID": "your-workspace-uuid"
      }
    }
  }
}
```

Restart Claude Desktop. The Maskin tools appear in the slash-command and tool menu.

### Claude Code

```bash
claude mcp add maskin \
  -e API_BASE_URL=http://localhost:3000 \
  -e API_KEY=ank_your_api_key_here \
  -e WORKSPACE_ID=your-workspace-uuid \
  -- npx -y @maskin/mcp
```

Then in your session, run `/reload-plugins` (or restart) to pick up the tools.

### Cursor

Add to `~/.cursor/mcp.json` (or **Settings → MCP → Add new MCP server**):

```json
{
  "mcpServers": {
    "maskin": {
      "command": "npx",
      "args": ["-y", "@maskin/mcp"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "API_KEY": "ank_your_api_key_here",
        "WORKSPACE_ID": "your-workspace-uuid"
      }
    }
  }
}
```

### VS Code + Cline

In Cline's MCP settings (or `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "maskin": {
      "command": "npx",
      "args": ["-y", "@maskin/mcp"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "API_KEY": "ank_your_api_key_here",
        "WORKSPACE_ID": "your-workspace-uuid"
      }
    }
  }
}
```

### Continue.dev, Zed, and other MCP clients

Anything that supports the standard `command` + `env` MCP-server schema works the same way: invoke `npx -y @maskin/mcp` with the three env vars above.

### HTTP transport (hosted Maskin)

If you're running Maskin as a hosted service, point your client at the built-in HTTP endpoint instead — no install required:

```
POST https://your-maskin-host/mcp
Authorization: Bearer ank_your_api_key_here
X-Workspace-Id: your-workspace-uuid
```

## First call: `get_started`

Once connected, the very first thing to ask the agent to do is **call `get_started`**. It previews a workspace template, asks a couple of tailoring questions, and applies a fully configured workspace (object types, statuses, seed bets/tasks, agent triggers) in one shot.

```
Configure my Maskin workspace with the "development" template.
```

```
Configure my Maskin workspace with the "growth" template.
```

```
Configure my Maskin workspace with a custom template.
```

## What you get — 39 tools

Grouped by what they do:

- **Onboarding** — `get_started`
- **Objects** — `create_objects`, `get_objects`, `list_objects`, `update_objects`, `delete_object`, `search_objects`
- **Relationships** — `create_relationships`, `list_relationships`, `delete_relationship`
- **Workspaces** — `create_workspace`, `list_workspaces`, `update_workspace`, `get_workspace_schema`, `add_workspace_member`
- **Actors** — `create_actor`, `get_actor`, `list_actors`, `update_actor`, `regenerate_api_key`
- **Sessions (agent runs)** — `create_session`, `list_sessions`, `get_session`, `pause_session`, `resume_session`, `stop_session`
- **Triggers (automations)** — `create_trigger`, `list_triggers`, `update_trigger`, `delete_trigger`
- **Events (audit log)** — `get_events`
- **Notifications** — `create_notification`, `list_notifications`, `get_notification`, `update_notification`, `delete_notification`
- **Integrations** — `connect_integration`, `disconnect_integration`, `list_integrations`, `list_integration_providers`
- **Extensions** — `create_extension`, `list_extensions`, `update_extension`, `delete_extension`
- **LLM keys** — `set_llm_api_key`, `get_llm_api_keys`, `delete_llm_api_key`
- **Claude subscription** — `import_claude_subscription`, `get_claude_subscription_status`, `disconnect_claude_subscription`
- **Direct agent invocation** — `run_agent`

Each tool ships with a detailed description that the model reads before calling it — open Claude/Cursor's tool inspector to see them.

## Programmatic use

`@maskin/mcp` is also importable as a library if you want to host it under your own transport:

```ts
import { createMcpServer, type McpConfig } from '@maskin/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const config: McpConfig = {
  apiBaseUrl: 'http://localhost:3000',
  apiKey: process.env.API_KEY!,
  defaultWorkspaceId: process.env.WORKSPACE_ID!,
  transport: 'stdio',
}

const server = createMcpServer(config)
await server.connect(new StdioServerTransport())
```

## Troubleshooting

- **"Not authenticated"** — `API_KEY` is missing or wrong. Check it starts with `ank_` and matches an active key in **Settings → API keys**.
- **"No workspace specified"** — set `WORKSPACE_ID` (or `DEFAULT_WORKSPACE_ID`) to a workspace UUID, or pass `workspace_id` to each tool. Use `list_workspaces` to discover available IDs.
- **"ECONNREFUSED localhost:3000"** — Maskin isn't running. Start it with `pnpm dev` or point `API_BASE_URL` at your hosted instance.
- **MCP App UI shows "not built yet"** — the embedded HTML resources are only available when running from a checked-out monorepo (`pnpm --filter @maskin/web build:mcp`). Tools work either way.

## Contributing & issues

Source lives in [`packages/mcp`](https://github.com/sindre-ai/maskin/tree/main/packages/mcp) of the main repo. Open issues and PRs at <https://github.com/sindre-ai/maskin>.

## Releasing (maintainers)

The package is built with `tsup` so the published artifact has no `@maskin/*` runtime deps — workspace deps are inlined.

```bash
# from the repo root
pnpm --filter @maskin/shared --filter @maskin/module-sdk build  # build deps that mcp imports at build-time
pnpm --filter @maskin/mcp build                                  # produce dist/
cd packages/mcp
pnpm pack                                                        # sanity-check the tarball contents
npm publish --access public                                      # requires npm auth for the @maskin scope
```

A GitHub Actions workflow that automates this on tag push (`mcp-vX.Y.Z`) can be added separately — it needs the `workflows` permission and an `NPM_TOKEN` secret with `@maskin` scope publish access.

## License

Apache-2.0
