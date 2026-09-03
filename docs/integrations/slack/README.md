# Slack app — Maskin

This directory holds the source of truth for the Slack app behind Maskin's
bot identity:

- `manifest.yml` — the Slack [app manifest](https://api.slack.com/reference/manifests) that defines display info, the bot user, OAuth scopes, and event subscriptions.
- `icon-placeholder.svg` — temporary brand mark for the app icon. Replace with the 512×512 PNG produced by the branded-profile spec (T2 on `bet/slack-trust-surface`) before the next operator-facing install.

## Upload steps

1. Open the [Slack app dashboard](https://api.slack.com/apps) and pick the Maskin app (one per environment — dev / prod).
2. Go to **Features → App Manifest** (left sidebar).
3. Switch the editor to **YAML**, paste the contents of `manifest.yml`, and **Save changes**.
4. Before saving, replace **both** occurrences of `REPLACE_WITH_ENV_URL` — in `settings.event_subscriptions.request_url` and in `oauth_config.redirect_urls` — with the public hostname of the target environment. Production is `maskin.io` (request URL → `/api/webhooks/slack`, redirect → `/api/integrations/slack/callback`).
5. Slack will show a diff against the current app state and list every change. **Read it.** Any change to scopes or events flips the app into a state where existing installations must re-authorise (see below).
6. Go to **Settings → Basic Information → App Icon** and upload the icon. Use the T2 PNG when ready; until then use `icon-placeholder.svg` exported to PNG at 512×512.
7. Go to **Settings → Install App** and re-install to every workspace that needs the new identity (mesh-firm first).

## Re-install warning

Slack does not silently broaden scopes or re-route event subscriptions on existing installations. **Any scope add/remove or event-subscription change in this manifest requires every existing install — including mesh-firm's — to re-authorise.** Until they do, the bot's stored OAuth token still reflects the old scope set and `chat.postMessage` calls that need newly-added scopes (e.g. `chat:write.customize`) will silently fail or fall back to misbehaviour.

Workflow when changing scopes:

1. Land the manifest change in this repo + Slack dashboard.
2. Hit **Install App → Reinstall to Workspace** in the Slack dashboard for every active workspace (or send the install URL to the operator if they own their own install).
3. Verify the new token starts with `xoxb-` and the new scope appears in `oauth.access` response (or in the Slack admin UI). The `xoxb-` guard in `apps/dev/src/services/session-manager.ts` will already refuse to inject a non-bot token, so a re-install that drops back to a user token would be caught at session start.

## Icon

The Slack app icon is **not** part of the manifest YAML — it is uploaded separately under **Settings → Basic Information → App Icon**. The runtime per-message `icon_url` override (set on every `chat.postMessage` call via the `chat:write.customize` scope) is governed by the `MASKIN_MACHINE_ICON_URL` env var consumed in `apps/dev/src/lib/integrations/providers/slack/mcp-server.ts`. Both should point at the same brand asset.

Until the T2 PNG lands, `icon-placeholder.svg` documents the placeholder. It is not loaded by any runtime path — it exists to show reviewers what is being uploaded and to give the next session an obvious "replace me" target.

## Scopes — bot vs user

The agent-posting path this bet ships uses **only the bot token** (`chat:write` + `chat:write.customize`). The `user` / `user_optional` scopes are retained from the live app because other Maskin features rely on the **user token** — Slack search (`search:read.*` is user-token-only), canvases, and file reads. They are intentionally NOT part of the trust-surface posting path; the runtime guard in `apps/dev/src/services/session-manager.ts` and `mcp-server.ts` refuses to post with a user (`xoxp-`) token. **Do not strip the user scopes** unless you have confirmed nothing in `apps/dev` reads the user token — removing them forces a re-authorise and breaks those features.

## What this manifest deliberately does NOT include

- **Slash commands** — none defined yet; bet `Slack as a trust surface` is identity-first.
- **Interactivity / shortcuts** — no shortcut or interactive request URL configured. Add when the bet that needs them is shaped.
- **Org-wide deploy / Socket Mode / token rotation** — explicitly disabled. Per-workspace install with a non-rotating bot token matches what `apps/dev/src/lib/integrations/providers/slack/config.ts` expects.

## Agent tool surface (MCP)

Agents reach Slack through the Maskin-hosted MCP server at
`POST /api/integrations/slack/mcp` (`apps/dev/src/routes/integrations-slack-mcp.ts`),
built per request by `createSlackMcpServer()` in
`apps/dev/src/lib/integrations/providers/slack/mcp-server.ts`.

| Tool | Slack method | Scope |
|------|--------------|-------|
| `slack_send_message` | `chat.postMessage` | `chat:write`, `chat:write.customize` |
| `slack_list_channels` | `conversations.list` | `channels:read`, `groups:read` |
| `slack_list_users` | `users.list` | `users:read` |
| `slack_join_channel` | `conversations.join` | `channels:join` |
| `slack_add_reaction` | `reactions.add` | `reactions:write` |
| `slack_get_permalink` | `chat.getPermalink` | — |
| `slack_get_channel_history` | `conversations.history` | `channels:history` / `groups:history` / `mpim:history` / `im:history` |
| `slack_get_thread_replies` | `conversations.replies` | `channels:history` / `groups:history` / `mpim:history` / `im:history` |
| `slack_update_message` | `chat.update` | `chat:write` |
| `slack_delete_message` | `chat.delete` | `chat:write` |
| `slack_open_conversation` | `conversations.open` | `im:write` (1:1 DM); group DMs need `mpim:write` — separate bet |
| `slack_conversations_info` | `conversations.info` | `channels:read` / `groups:read` / `im:read` / `mpim:read` |

Every one of these scopes is already in `manifest.yml` and in the provider's
`scopes` array, so adding the tools needed **no manifest change and no
re-authorisation** for the five discovery tools that shipped in PR #1456.
The two read-history tools (`slack_get_channel_history` /
`slack_get_thread_replies`) do need the three new history scopes
(`channels:history` / `groups:history` / `mpim:history`) — existing installs
degrade gracefully via `withScopeHint()`, which rewrites Slack's
`missing_scope` into a "Reconnect Slack from Settings → Integrations"
instruction. The four fold-in tools ride on scopes already granted, so they
require no reconnect.

`slack_list_channels` and `slack_list_users` share the 5-minute lookup cache in
`providers/slack/client.ts` with the REST routes that back the trigger-filter
UI, keyed by integration id — which is why `SlackPostContext` carries
`integrationId`.

Channel arguments accept either an ID (`C0123456789`) or a name (`#general`);
`resolveChannelId()` looks the name up via `conversations.list`, with a small
DM/MPIM fallback so the read-history tools can resolve MPIMs referenced by
their `mpdm-…` name. True 1:1 DMs have no name and must be referenced by
their D-prefixed ID directly.

### History tools — bounded, member-only, agent-driven pagination

`slack_get_channel_history` and `slack_get_thread_replies` read messages the
bot can see. **Member-only:** the bot sees history in channels, DMs, and
MPIMs it is a member of; private channels still require an `/invite`. When
the bot is not in a channel the tool returns Slack's `not_in_channel`,
rewritten to the actionable *"call `slack_join_channel` first"* hint.

**Bounded returned shape.** Each message maps to `{ ts, user, text,
thread_ts?, reply_count?, latest_reply?, subtype?, bot_id? }`. Slack's
`blocks`, `attachments`, `files`, `reactions`, and `edited` are
intentionally not exposed — if a follow-up bet needs one of them, expose it
explicitly then.

**Agent-driven pagination.** The tools do not auto-follow cursors. Each
response includes `truncated` (from Slack's `has_more`) and `next_cursor`
(from `response_metadata.next_cursor`). Callers decide whether to page
further; the tool caps a single call to Slack's `limit` (default 50, max
200) so a busy channel cannot blow the tool-call context.

`slack_get_thread_replies` includes the parent message flagged
`is_parent: true` so the agent does not have to make a second call to see
what it is replying to.

### Write-side edit / delete tools

`slack_update_message` replaces the target message's content in full — pass
the complete new text, not a diff. `slack_delete_message` is permanent.
**The bot can only update or delete its OWN messages** (Slack API
constraint). When the target message was not posted by this bot token,
Slack returns `cant_update_message` / `cant_delete_message`, which the tools
rewrite to *"it was not posted by the Maskin bot"*. Enterprise workspaces
with compliance exports enabled may disallow deletes entirely; Slack's
`compliance_exports_prevent_deletion` passes through unchanged.

### 1:1 and group DM open

`slack_open_conversation` opens a conversation between the bot and 1–8
users (comma-joined as Slack's `users` param). One user → 1:1 DM on the
already-granted `im:write` scope. Multiple users → group DM on
`mpim:write`, which is **not granted** today, so multi-user calls surface
as a reconnect instruction via `withScopeHint()`. Requesting `mpim:write`
is a separate follow-on bet. Returns `{ channel_id, is_new, users }`;
`is_new: false` when Slack returned the existing DM channel.

### Channel info

`slack_conversations_info` returns a bounded channel-info shape:
`{ id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived,
is_member, topic, purpose, num_members?, created }`. Enterprise-shared /
org-shared fields (`previous_names`, `pending_shared`, `shared_team_ids`,
`pending_connected_team_ids`, topic/purpose creator metadata) are
intentionally not exposed. `include_num_members: true` adds `num_members`
(defaults to false to skip the small Slack-side cost).
