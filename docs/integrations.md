# Integrations — OAuth from chat

Maskin's `connect_integration` MCP tool starts an OAuth flow with the chosen
provider (GitHub, Slack, Google …). This document covers the pieces involved
in returning the user to the chat surface after the OAuth handshake settles.

## High-level flow

```
┌─ Claude.ai chat ──────────────────────────────────────────────────────────┐
│                                                                           │
│  ┌────────────── MCP card ────────────────┐                               │
│  │  Connect button                        │                               │
│  │     │                                  │                               │
│  │     ▼                                  │                               │
│  │  callTool('connect_integration')       │ ── POST /api/integrations/    │
│  │     │                                  │            :provider/connect  │
│  │     ▼                                  │ ◄─ { install_url }            │
│  │  window.open(install_url, popup)       │                               │
│  │     │                                  │                               │
│  │     ▼                                  │                               │
│  │  window.addEventListener('message')    │                               │
│  │                                        │                               │
│  └────────────────────────────────────────┘                               │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ user authenticates with provider
                              │
                              ▼
                    GET /api/integrations/:provider/callback
                              │
                              ▼ exchange code, persist credentials
                              │
                              ▼
                    302 redirect → ${FRONTEND_URL}/oauth-return?…
                              │
                              ▼
        ┌────── Maskin web app /oauth-return (popup window) ────┐
        │                                                        │
        │  if (window.opener && window.opener !== window) {      │
        │     opener.postMessage({ type: 'maskin:oauth-return',  │
        │                          status, provider, … }, '*')   │
        │     window.close()                                     │
        │  } else {                                              │
        │     window.location.replace('/{ws}/settings/…')        │
        │  }                                                     │
        │                                                        │
        └────────────────────────────────────────────────────────┘
```

The `/oauth-return` route is the **single shim** the backend redirects to —
the route picks one of two paths at runtime so we can preserve the existing
settings-page UX (full-page redirect → bounce to `/settings/integrations`)
while also enabling the rich-app card flow (postMessage → close).

## Pieces

### Backend — `apps/dev/src/routes/integrations.ts`

After the code exchange completes (or fails), the callback redirects to:

```
${FRONTEND_URL}/oauth-return?provider=…&workspace_id=…&status=success|error&error_code=…
```

Built by `buildOauthReturnUrl()` in the same file. `FRONTEND_URL` defaults to
`http://localhost:5173` for local development; set it explicitly in any
deployed environment. The dev server logs a warning at startup when it's
missing — see `apps/dev/src/index.ts`.

`FRONTEND_URL` is already listed in `turbo.json#globalPassThroughEnv`, so it
flows through to all packages.

### Frontend shim — `apps/web/src/routes/oauth-return.tsx`

Public route (no auth guard). On mount it picks one of two branches:

1. **Popup (chat-card flow)** — when `window.opener && window.opener !== window`,
   `postMessage` the parsed query params to the opener under the message type
   `maskin:oauth-return` and `window.close()`.
2. **Full-page (settings flow)** — bounce to
   `/{workspaceId}/settings/integrations?status=…` so the legacy redirect from
   the settings page keeps working.

The message type and field shape are exported as `POST_MESSAGE_TYPE` and the
`OauthReturnMessage` interface, so the MCP card and the shim cannot drift.

### MCP card — `apps/web/src/mcp-apps/integrations/`

The `Connect` button on each provider row:

1. Calls `connect_integration` (MCP tool) → receives `install_url`.
2. Opens `install_url` in a popup with a fixed window name (`maskin-oauth`).
3. Calls `waitForOauthReturn(...)` which adds a `message` listener and a
   `popup.closed` poll. Resolves when the shim posts back, or when the user
   closes the popup early.
4. Filters incoming `message` events on `event.origin` (compared against the
   MCP server's `webAppBaseUrl`) and `event.data.type === 'maskin:oauth-return'`
   so an unrelated postMessage cannot trigger a refresh.
5. On success, calls `list_integrations` to refresh the card.

### Server tools

`list_integrations`, `list_integration_providers`, `connect_integration`, and
`disconnect_integration` are all wired to the new
`ui://maskin/integrations` resource so any of those tool calls renders the
card by default.

## Adding a new OAuth provider

See `.claude/rules/integrations.md` — the only OAuth-from-chat-specific note is
that any new provider's callback automatically flows through the shim above,
so no per-provider work is required.

## Testing locally

1. Set `FRONTEND_URL=http://localhost:5173` in `.env` (or accept the dev
   default; the warning is informational).
2. Run `pnpm dev` and `claude mcp add` per `CLAUDE.md`.
3. In Claude, ask: _"Connect the GitHub integration."_ The agent calls
   `list_integration_providers`, the card renders, click `Connect`, complete
   the OAuth handshake, and confirm the card flips to the connected state
   without leaving Claude.
