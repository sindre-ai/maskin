# Gemini CLI extension gallery: listing notes

Gemini CLI lists extensions from public GitHub repos with no review and no submission. This file says what the gallery reads and what a person must do once after merge. Nothing here is secret.

Requirements source: Google's "Extension releasing" page (https://geminicli.com/docs/extensions/releasing/), re-read 2026-11-23.

## What the gallery reads

- A public GitHub repo with the topic `gemini-cli-extension`. The crawler uses the topic to find extensions.
- `gemini-extension.json` at the repo root. It is there, with `name`, `version`, `description`, two `settings` and one `mcpServers` entry pointing at https://maskin.io/mcp.
- A tagged release. "Once you tag your repository, your extension will appear in the gallery if it passes validation." The crawl is daily. The `version` in the manifest should match the release tag.

## Install

```
gemini extensions install https://github.com/sindre-ai/maskin
```

Gemini CLI asks for the Maskin API key (stored in the system keychain) and the workspace ID. Both are on the Other tab under Settings → MCP in Maskin.

## Sign-in

Key-based only. With no key, Gemini CLI tries sign-in against https://maskin.io/mcp and ends up disconnected: our authorization server has no client sign-up endpoint and pins only Claude and ChatGPT (`docs/reference/mcp-oauth.md`). Gemini CLI sign-in would need a new pinned client, which is out of scope here.

## What was tested (Gemini CLI 0.70.0, 2026-11-23)

- `gemini extensions validate .` passes.
- `gemini extensions install <repo copy>` installs, asks for both settings, stores the key in the keychain.
- `gemini mcp list` shows the server as Connected (handshake and headers reach https://maskin.io/mcp).
- Without a key, the same URL shows Disconnected.
- Not tested: a tool call through Gemini itself with a valid key. That needs a real Maskin key and a Google sign-in for the model.

## After merge (a person)

1. Add the topic `gemini-cli-extension` to the sindre-ai/maskin repo (About → topics).
2. Publish a GitHub release tagged to match the manifest version (`v0.1.0`). Bump `version` in `gemini-extension.json` and tag again for any later change.
3. A day later, check the extension appears at https://geminicli.com/extensions.
