# Repository association

- **App**: [sindre-ai/maskin](https://github.com/sindre-ai/maskin) (`main`) — the product surface this skill governs.

## Source of truth

`maskin-app-v2.html` is a verbatim copy of the file the owner attached to the parent bet **Cross-cutting QA — states, dark mode, accessibility, consistency audit** on 2026-08-14 as the sole visual reference for the v2 rebuild. See the parent bet's "Chosen direction" for the decision to switch from the earlier warm-paper direction to v2.

The bundle is a self-contained "bundled page" whose `__bundler/manifest` block carries the compressed `.dc` markup, its `support.js` runtime, and the fonts. `maskin-app-v2.dc.html` and `support.js` in this folder are those two blobs extracted (gunzipped, base64-decoded) so they can be read by line and grepped without decoding the whole bundle each time. Both are verbatim from the manifest; regenerate with `node -e "..."` against the manifest block if the bundle is ever refreshed.

## Sync log

| Date | Change |
|---|---|
| 2026-08-16 | Regenerated the skill from `Maskin App v2 Standalone.html`. Rewrote tokens against the v2 zinc-and-indigo values used inline in the file. Extracted `maskin-app-v2.dc.html` + `support.js` from the bundle's manifest so the mockup is greppable by line number and `MOCKUP-INDEX.md` can point to real sections. Scoped the readme, SKILL and MOCKUP-INDEX honestly — the v2 bundle ships only the For You feed v4 prototype, not fourteen route mockups; other routes read the shared vocabulary (tokens + patterns) from the same file. Dropped the Newsreader italic reference — v2 does not use it. |
| 2026-08-18 | Replaced the feed-only v2 files with the **full app prototype** (`exports/Maskin App export-src.dc.html` → `maskin-app-v2.dc.html`, flattened, all fourteen screens, For You inlined; `Maskin App.html` → `maskin-app-v2.html`). Rewrote `MOCKUP-INDEX.md` as a per-screen line map and corrected SKILL.md + readme.md, which both claimed the bundle shipped only the For You feed v4 and that other routes had no per-view mockup. `support.js` unchanged (identical md5). Tokens unchanged — the full mockup uses the same zinc-and-indigo values already in `tokens/`. |
