---
title: Agent access (grants)
slug: agent-access
description: Which agents may use an integration or a saved credential, and how — read, read & write, or none — how it is enforced, and how an agent is told.
last_updated: 2026-10-20
---

# Agent access (grants)

A person decides what each agent may do with each connected integration and each saved credential. Everything except the Maskin MCP is covered.

## One source of truth, shown the same everywhere

Access lives in `agent_grants` plus `integrations.default_agent_access`, resolved by `lib/integrations/agent-access.ts`. Every screen and tool reads that, never its own copy, and a change made anywhere shows up everywhere:

| Surface | Reads | Changes through |
|---------|-------|-----------------|
| Integrations page | `GET /api/integrations` (`defaultAgentAccess`, `agentGrants`) | the grants and default-access routes |
| Keychain page | the same list | `PUT /:id/grants` |
| Agent page (Access) | `GET /api/actors/:id/access` | the same grants routes |
| `get_actor` (`access`) | `GET /api/actors/:id/access` | `update_integration_access` |
| `list_integrations` | `GET /api/integrations` | `update_integration_access` |
| `list_keychain_credentials` | `describeAgentAccess` | `request_keychain_access` (a person allows) |
| Launch prompt and attached servers | `listAgentAccess` / `attachesServer` | (never written: read at launch) |

Rules that keep it that way:

- Add a new place that shows or changes access by reading `describeAgentAccess` / the grants routes, not by recomputing it. "Is the MCP server attached" is `attachesServer()`, used by launch and by every report of it.
- Wording comes from `@maskin/shared` (`AGENT_ACCESS_LABELS`, `AGENT_ACCESS_EFFECT`): "Read", "Read & write", "No access". There is no write-only level: an agent that may change something may also look at it.
- Web: the per-agent access query is nested under `queryKeys.integrations.all(workspaceId)`, and the SSE handler invalidates that key on every `integration` event, so an open page refreshes when access changes elsewhere.
- `apps/dev/src/__tests__/integration/access-alignment.test.ts` changes access through every entry point and asserts the list, the agent view, the session list and a real launch agree after each. Extend it when you add an entry point.

## The model

- `agent_grants` holds one row per `(integration, agent)` with `access` = `none`, `read` or `read_write`. `none` is an explicit no that beats a `read` default, so one agent can be taken off an integration the others can read. Unique on `(integration_id, actor_id)`; cascades when either side is deleted.
- `integrations.default_agent_access` is what an agent with **no row** gets: `read` (the default for every ordinary integration) or `none`.
- A **Keychain credential** (a saved API key or login) has no default and no read/write split: an agent has it or it does not. A grant row means on (stored as `read_write`, never `none`); no row means off. This holds for people too — only ordinary integrations let a person through.
- Resolution lives in one place: `apps/dev/src/lib/integrations/agent-access.ts`. Do not re-derive it.

| Situation | Access |
|-----------|--------|
| Ordinary integration, agent has a row | the row |
| Ordinary integration, no row | `default_agent_access` |
| Saved key or login, row exists | on |
| Saved key or login, no row | off |
| Actor that does not exist | none |

## API

All humans-only, writer role, and only the person who connected the integration or a workspace admin/owner. Each change writes an `events` row (and a `scope_changed` audit row for a Keychain credential).

- `GET  /api/integrations/:id/grants` — default access, mode (`keychain` | `standard`), explicit grants.
- `PUT  /api/integrations/:id/grants` — replace every explicit grant at once.
- `PUT  /api/integrations/:id/grants/:actorId` — set one agent's access.
- `DELETE /api/integrations/:id/grants/:actorId` — remove it; the agent falls back to the default.
- `PUT  /api/integrations/:id/default-access` — `read` or `none`. Not allowed for a saved key or login.

`GET /api/integrations` returns `defaultAgentAccess` and `agentGrants` on each row. Chat capture takes `agentIds` (omitted: the session's agent; `[]`: nobody).

## Enforcement

1. **Keychain.** `getCredential` and the launch-time env injection check the grant.
2. **Maskin-hosted MCPs (Slack, LinkedIn, Google Meet).** `tool-gate.ts` wraps tool registration. Every tool is classified read or write by `tool-kinds.ts` (curated lists; anything unlisted is a write). A tool the agent cannot use is marked `[Unavailable: …]` in its description, and a call is refused with a message that says what was needed and who can grant it.
3. **Hosted MCPs (Gmail, Google Calendar, Linear, PostHog).** These go through `/api/integrations/:provider/gateway`. The agent signs in to Maskin with its own key; Maskin holds the provider token, refuses writes for read-only agents, and forwards the rest. At launch these providers' tokens are **not** put in the container, and any MCP entry pointing at the provider's own URL is rewritten to the gateway.
4. **Up front.** The launch system prompt gets an `## Integration access` block listing the agent's level per connected integration.

A refused call writes an `agent_access_denied` event on the integration.

## Attaching the tools

Access is also what attaches an integration's MCP server to an agent: at launch, every connected integration the agent can use (default read, or a grant) gets its server, with no per-agent setup. No access means no server. LinkedIn attaches one server per connected identity. A server the agent already added by hand at the same URL is not attached twice. A change on the Integrations page applies from the next session.

## Asking for a credential that already exists

Two MCP tools, used inside a chat:

- `list_keychain_credentials` — names, kind and whether the agent already has each. Never a value.
- `request_keychain_access` — posts an Allow / Not now card (`metadata.keychain_access_request`). The person chooses how long: **Allow in this chat** (`scope: 'chat'`, a row in `agent_chat_grants`: this agent, this conversation only, gone with the chat) or **Always allow** (`scope: 'always'`, a normal `agent_grants` row until removed). Either calls `POST /api/integrations/:id/allow-from-chat`, which grants *the agent whose session asked* (a person only: whoever saved it, or a workspace admin), audits it, and restarts that session so the credential is in its environment. Turning the credential off for the agent removes both kinds. Not now only sends the agent a message. A chat-scoped Allow shows as `scope: 'this_chat'` in `list_keychain_credentials`, as `chatGrants` on the integration list, and as "Only in N chats" on the agent page. `request_keychain_credential` remains for a credential that does not exist yet.

## Classification

`tool-kinds.ts` is fail-closed. For providers Maskin hosts, a tool is a read only if it is in the provider's curated set. For gateway providers the order is: the server's own `destructiveHint` (write), its `readOnlyHint` (read), then a name rule that requires a read verb (`get_`, `list_`, `search_`, …) and no write word anywhere in the name. A wrong "write" costs a refused call; a wrong "read" lets an agent act without permission, so ambiguity resolves to write.

When you add a tool to a provider Maskin hosts, add it to `READ_TOOLS` if it only reads. Otherwise do nothing.

## What is not gated

- **GitHub.** Its MCP server runs in the container with the installation token, which git itself also needs. Its limit is the GitHub App's permissions.
- **Resend, Ubersuggest.** API-key services the agent also calls over plain HTTP.
- **The Maskin MCP.** Exempt by design.

Adding a provider to `GATEWAY_PROVIDERS` changes what a container receives (no token env var), so it is a deliberate edit, not a side effect.
