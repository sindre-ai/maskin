# Slack app — Machine

This directory holds the source of truth for the Slack app behind Maskin's
Machine identity:

- `manifest.yml` — the Slack [app manifest](https://api.slack.com/reference/manifests) that defines display info, the bot user, OAuth scopes, and event subscriptions.
- `icon-placeholder.svg` — temporary brand mark for the app icon. Replace with the 512×512 PNG produced by the branded-profile spec (T2 on `bet/slack-trust-surface`) before the next operator-facing install.

## Upload steps

1. Open the [Slack app dashboard](https://api.slack.com/apps) and pick the Maskin/Machine app (one per environment — dev / prod).
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
