---
title: Agent access (grants)
slug: agent-access
description: Which agents may use an integration or a saved credential, and how — read, read & write, or none — how it is enforced, and how an agent is told.
last_updated: 2026-10-21
---

# Agent access (grants)

A person decides what each agent may do with each connected integration, each saved credential and each custom tool server. The Maskin MCP is the exception: it is on every agent, read & write, and nobody can change that.

## One source of truth, shown the same everywhere

Access lives in `agent_grants` plus `integrations.default_agent_access`, resolved by `lib/integrations/agent-access.ts`. Every screen and tool reads that, never its own copy, and a change made anywhere shows up everywhere:

| Surface | Reads | Changes through |
|---------|-------|-----------------|
| Integrations page | `GET /api/integrations` (`defaultAgentAccess`, `agentGrants`) | the grants and default-access routes |
| Keychain page | the same list | `PUT /:id/grants` |
| Agent page (Tools and access) | `GET /api/actors/:id/access` | the same grants routes |
| `get_actor` (`access`) | `GET /api/actors/:id/access` | `update_integration_access` |
| `list_integrations` | `GET /api/integrations` | `update_integration_access` |
| `list_keychain_credentials` | `describeAgentAccess` | `request_keychain_access` (a person allows) |
| Launch prompt and attached servers | `listAgentAccess` / `attachesServer` | (never written: read at launch) |

Rules that keep it that way:

- Add a new place that shows or changes access by reading `describeAgentAccess` / the grants routes, not by recomputing it. "Is the MCP server attached" is `attachesServer()`, used by launch and by every report of it.
- Wording comes from `@maskin/shared` (`AGENT_ACCESS_LABELS`, `AGENT_ACCESS_EFFECT`): "Read", "Read & write", "No access". There is no write-only level: an agent that may change something may also look at it.
- Web: the per-agent access query is nested under `queryKeys.integrations.all(workspaceId)`, and the SSE handler invalidates that key on every `integration` event, so an open page refreshes when access changes elsewhere.
- `apps/dev/src/__tests__/integration/access-alignment.test.ts` changes access through every entry point and asserts the list, the agent view, the session list and a real launch agree after each. Extend it when you add an entry point.

## The Maskin MCP is not a choice

Without it an agent cannot read or write anything in Maskin, so it is attached to every session whether or not the agent's own config lists it (`session-manager.ts`, via `hasMaskinMcpEntry` / `MASKIN_MCP_SERVER` in `lib/mcp-session-header.ts`). It has no grant row and no control: the Integrations page (under Custom tools) and the agent page (under Tools) show it as a locked "Read & write" row, and `describeAgentAccess` reports it as `maskin_mcp` so every screen says the same thing. An agent that already lists it (the usual case for older agents) does not get a second one.

## Tools: custom MCP servers

An MCP server a person adds by hand (a command to run, or a URL to call) is a workspace-level **tool server**, managed in the **Custom tools** section of Settings → Integrations and shared with agents through the same grants, instead of being set up on each agent. The agent page no longer has a Tools editor; its "Tools and access" section lists what the agent has and switches it on or off.

- One `integrations` row per server: `provider = custom-mcp`, `provider_mode = registered`, `display_name` is its name, `external_id` is the row id (the unique index on workspace, actor and provider would otherwise let a workspace hold one). The definition (command, args, env, URL, headers) is the encrypted `credentials` blob; `config.custom_mcp` is a non-secret summary (`transport`, `target`) that every member can see.
- `default_agent_access` starts `none`: a new server reaches no agent until a person picks them, or turns on **All agents** (`read`).
- **Levels depend on whether Maskin can sit in front of the server.** An HTTP server at a public address (`isGatewayable`; recorded as `config.custom_mcp.gated`) has the same Read / Read & write / No access as a built-in integration, enforced by `/api/custom-mcp-servers/:id/gateway` (the same proxy as the provider gateway: Maskin keeps the server's headers, the agent signs in with its own key, a refused write never reaches the server). Tools are classified read or write by the server's own hints, then by name, failing closed (`tool-kinds.ts`). A stdio server runs inside the agent's container and a URL that is a `${PLACEHOLDER}` or a private, loopback or link-local address cannot be reached from the API, so those are on (`read_write`) or off (`none`) only, and the grants routes refuse `read` for them. The gateway also refuses a name that resolves to a private address. An edit that makes a gated server ungateable turns its Read grants into No access.
- At launch an agent with access gets the server under `custom-<name>-<id>` (`customServerKey`), pointed at the gateway when it is gated so the agent never holds its headers; one the agent already carries is not attached twice. The launch prompt's access block leaves custom servers out: they are simply there or not.
- API: `POST /api/custom-mcp-servers`, `GET|PUT /api/custom-mcp-servers/:id`; removal is `DELETE /api/integrations/:id`. Humans only; editing is for whoever added it or a workspace admin. A read returns env and header values (and secret-looking args) masked; sending the mask back keeps the stored value, but only while the command or URL is unchanged, so a mask cannot be used to send a stored secret somewhere new.
- **Saved credentials instead of pasted secrets.** An env or header value can name a Keychain credential, written `${KEYCHAIN_BYO_APIKEY_STRIPE}` (a login is `..._USERNAME` / `..._PASSWORD`), which the form's "Saved credential" picker inserts. The server stores the reference, never the secret, so rotating the key in the Keychain updates every server that uses it. A reference is accepted only in env and header values (not the command, args, URL or a name), only for a credential that exists, and only from whoever saved that credential or a workspace admin, so nobody can aim a server at someone else's key; it is re-checked when the command or URL changes. It is filled in per credential access: for a gated HTTP server Maskin reads it as the calling agent at call time (grants apply, the read is audited, the agent never sees it); for a server that runs in the container, envsubst fills it from the `KEYCHAIN_` env the Keychain injects. An agent without the credential does not get a container server (the launch prompt says which credential it needs and points at `request_keychain_access`); a gated server stays attached and its calls fail with the same message. A reference shows back unmasked; any other value stays masked.
- It is not a provider you "connect": `/providers` leaves it out and `POST /api/integrations/custom-mcp/connect` refuses it.
- **Existing servers move up.** On startup `migrateAgentToolServers` (`lib/integrations/migrate-agent-tool-servers.ts`) turns each server found in an agent's `tools.mcpServers` into one row, with a read & write grant for every agent that had it, and removes it from the agent. The same server on several agents is one row. Left alone: the Maskin entry, anything that belongs to a connected integration (`/api/integrations/...`, a provider's own MCP URL, GitHub), and anything that does not validate. It is idempotent and takes an advisory lock per workspace. An agent created later with `tools.mcpServers` set through the API still works at launch, but nothing shows or edits it on the agent page.

## The model

- `agent_grants` holds one row per `(integration, agent)` with `access` = `none`, `read` or `read_write`. `none` is an explicit no that beats a `read` default, so one agent can be taken off an integration the others can read. Unique on `(integration_id, actor_id)`; cascades when either side is deleted.
- `integrations.default_agent_access` is what an agent with **no row** gets: `read` (the default for every ordinary integration), `read_write` (every agent may also write) or `none`. A per-agent row still beats the default in both directions, e.g. one agent held to `read` while the rest write. Read & write is the risky level, which is why the default for an ordinary integration is `read`.
- A **Keychain credential** (a saved API key or login) has no default and no read/write split: an agent has it or it does not. A grant row means on (stored as `read_write`, never `none`); no row means off. This holds for people too — only ordinary integrations let a person through.
- Resolution lives in one place: `apps/dev/src/lib/integrations/agent-access.ts`. Do not re-derive it.

| Situation | Access |
|-----------|--------|
| Ordinary integration, agent has a row | the row |
| Ordinary integration, no row | `default_agent_access` |
| Saved key or login, row exists | on |
| Saved key or login, no row | off |
| Actor that does not exist | none |

## Read & write and actions that cannot be undone

`read_write` lets an agent use every tool of the integration. Where a tool does something that cannot be undone, the tool itself still waits for a person's yes, whatever the level: a person approves that one action, the agent cannot approve it for itself.

- **Which providers:** `APPROVAL_GATED_PROVIDERS` in `packages/shared/src/agent-access.ts`, today Gmail (sending an email, approved on the draft or on a For You approval card, see "Sending email through Gmail" below). Adding a provider is a promise that its tool refuses the action until a person has approved it and says how to ask.
- **What it means in code:** `canWrite` is true for `read_write`, and the tool does the asking. There is no separate level for it: an earlier "Ask first" level was folded into Read & write.
- **Migration 0107** turned every `ask_first` grant into `read_write` (same behaviour: those agents already needed approval to send). Its down migration puts Gmail `read_write` grants back on `ask_first` so a rollback does not let an agent send on its own.

## Sending email through Gmail

Google's hosted Gmail tool can only create drafts, so Maskin serves the send itself: the `gmail_send_email` MCP tool, `POST /api/integrations/gmail/send` (`apps/dev/src/routes/integrations-gmail.ts`).

- **Sending needs both Read & write and a person's approval of that exact email.** An agent with **Read** or no access cannot send, not even an approved email. An agent with Read & write may draft freely, but a direct send (`to`/`subject`/`body`) is refused with instructions to ask: no email goes out on an agent's own say-so. There is no "send on its own" setting and so no per-recipient exception (a protected contact, an opt-out) to make: a person looked at every email.
- **Asking is the For You approval card.** The agent posts a comment with a `decision` whose `draft` is the email (`to` with a real address, the text starting with a "Subject: ..." line so the person approves the subject too) and exactly one `destructive` option, the send. A person's tap is stored as a reply under the card. The agent then calls the tool with `approval_comment_id`.
- **The server reads the approval back rather than trusting the agent.** The card must be the caller's own. The latest answer under it must come from a person (an agent's reply never counts) and equal the send option. The draft's text must not have changed since that answer, because the person approved other text: only a logged edit to its content counts (moving the task to another status or changing its driver does not), and an object that moved on with no logged reason is treated as changed. Then the email goes out exactly as the card shows it.
- **One approval, one email.** The send claims the approval before calling Gmail (`send_claim` events on the integration, serialised with an advisory lock). Gmail refusing it releases the claim; an unclear failure (5xx, dropped connection) locks it, since sending again could deliver it twice. A direct send is also refused if the same email went out in the last 24 hours.
- No new OAuth scope: `gmail.compose` is already requested and covers sending.

## Sending email through Resend

Maskin serves the Resend send as well: the `resend_send_email` MCP tool, `POST /api/integrations/resend/send` (`apps/dev/src/routes/integrations-resend.ts`). It works like the Gmail send above, with these differences:

- **Only `object_id`.** The email is the draft object (`metadata.kind = "email"`) as it reads now. A `to`, `subject`, `body` or `from` in the call is refused, not ignored.
- **The sender is the agent's mailbox, read on the server.** It lives in `actors.metadata.mailbox`. Only a human workspace admin or owner can set it (`PATCH /api/actors/:id` with `mailbox`; an address is one plain address and one agent holds it). The `email` column is not used: any workspace member can change it. No mailbox, no send. The draft cannot name a sender either.
- **The approval is the idempotency key** (`maskin-email-{object_id}-{approval event id}`), so Resend delivers a retry once. A refusal or an unclear failure releases the approval (`resend_action: send_released` on the integration) and the same call can be made again; a confirmed send locks it.
- Resend's own send tools through the gateway are held in a separate change; until then they still work for Read & write agents.

## API

All humans-only, writer role, and only the person who connected the integration or a workspace admin/owner. Each change writes an `events` row (and a `scope_changed` audit row for a Keychain credential).

- `GET  /api/integrations/:id/grants` — default access, mode (`keychain` | `standard`), explicit grants.
- `PUT  /api/integrations/:id/grants` — replace every explicit grant at once.
- `PUT  /api/integrations/:id/grants/:actorId` — set one agent's access.
- `DELETE /api/integrations/:id/grants/:actorId` — remove it; the agent falls back to the default.
- `PUT  /api/integrations/:id/default-access` — `read`, `read_write` or `none`. Not allowed for a saved key or login.

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
- `request_keychain_access` — posts an Allow / Not now card (`metadata.keychain_access_request`). The person chooses how long: **Allow in this chat** (`scope: 'chat'`, a row in `agent_chat_grants`: this agent, this conversation only, gone with the chat) or **Always allow** (`scope: 'always'`, a normal `agent_grants` row until removed). Either calls `POST /api/integrations/:id/allow-from-chat`, which grants *the agent whose session asked* (a person only: whoever saved it, or a workspace admin), audits it, and restarts that session so it has the credential: an API key is in its environment, but a saved login never is. The agent types a login on its computer with `desktop_type` and `{{keychain:<Name>.password}}`, which Maskin fills in (`lib/integrations/keychain-typing.ts`), so the password never reaches the session. Turning the credential off for the agent removes both kinds. Not now only sends the agent a message. A chat-scoped Allow shows as `scope: 'this_chat'` in `list_keychain_credentials`, as `chatGrants` on the integration list, and as "Only in N chats" on the agent page. `request_keychain_credential` remains for a credential that does not exist yet.
- `request_integration_access` — for an integration that is already connected but not allowed for the agent, or not at the level it needs (`integration_id` from `list_integrations`, `level` `read` or `read_write`, optional `reason`). Posts an Allow / Not now card (`metadata.integration_access_request`). Allow calls `POST /api/integrations/:id/allow-access`, a person only (whoever connected it, or a workspace admin), which sets the agent's own entry to that level (the same per-agent access as Settings → Integrations, audited as `agent_grant` with `via: 'chat_card'`) and restarts that session so it knows. It only ever raises: an agent that already has the level, by entry or default, is left as it is. An agent cannot allow itself; `update_integration_access` still refuses agents. A saved key or login goes through `request_keychain_access` instead. Always allow only: a chat-only lift of an integration is not built (see the chat-write-access bet). The access block and the refusal text point agents at this tool when a person is in the chat.
- `add_mcp_server` — for a tool (MCP) server the agent knows how to run or reach: `name`, then `command` and `args` (runs in its container) or `url` (remote), non-secret `env` and `headers` (a value may be a `${KEYCHAIN_...}` reference), and the names of what the person must type in (`secret_env`, `secret_headers`). Posts an Add / Not now card (`metadata.mcp_server_request`) that shows the command or address and an input per secret. The route (`POST /api/sessions/:id/mcp-server-card`) refuses a definition that could not be added by hand, a name in both the values and the secrets, and a key-looking arg, so the message never holds a secret. Add is the person's own two calls, never the agent's: `POST /api/custom-mcp-servers` (a person only) with the typed secrets, then `POST /api/integrations/:id/allow-access` at `read_write` for the agent whose session asked, which restarts that session so the server is attached. If the second call fails the card keeps the saved server and a retry only gives access. Not now only sends the agent a message.

## Classification

`tool-kinds.ts` is fail-closed. For providers Maskin hosts, a tool is a read only if it is in the provider's curated set. For gateway providers the order is: the server's own `destructiveHint` (write), its `readOnlyHint` (read), then a name rule that requires a read verb (`get_`, `list_`, `search_`, …) and no write word anywhere in the name. A wrong "write" costs a refused call; a wrong "read" lets an agent act without permission, so ambiguity resolves to write.

When you add a tool to a provider Maskin hosts, add it to `READ_TOOLS` if it only reads. Otherwise do nothing.

### Held tools (Resend)

A third kind, `outbound`, is a tool that sends email or can set a send off. **No access level unlocks it**, Read & write included: the gateway refuses the call with a message that points to `resend_send_email`, and `tools/list` marks it unavailable.

Resend is curated the other way round from Slack: `RESEND_READ_TOOLS` (reads) and `RESEND_SAFE_WRITE_TOOLS` (templates, contacts, domains) are exact name lists, and **everything else is held**. Resend loads more tools on demand (`get_more_tools`), so a tool nobody has classified, a new one included, is held until someone adds it to a list. The server's own hints never move a Resend tool: `readOnlyHint` on `send-email` changes nothing. The held tools include the seven send tools, `send-event`, `update-email`, `cancel-email`, broadcasts, automations, API keys, webhooks, inboxes and drafts, suppressions and segments. Every refusal is logged as an `agent_access_denied` event with `kind: "outbound"`.

Adding a Resend tool to either list is a decision about whether it can send, directly or later: read the tool's schema first.

## What is not gated

- **GitHub.** Its MCP server runs in the container with the installation token, which git itself also needs. Its limit is the GitHub App's permissions.
- **Ubersuggest.** An API-key service the agent also calls over plain HTTP. (Resend is gated, see Held tools above.)
- **The Maskin MCP.** Exempt by design.

Adding a provider to `GATEWAY_PROVIDERS` changes what a container receives (no token env var), so it is a deliberate edit, not a side effect.
