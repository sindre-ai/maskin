---
name: maskin-design
description: The v2 Maskin app design system — tokens, type, radii, shadows, motion, and component patterns extracted from the full Maskin App v2 prototype (all fourteen product screens plus the shell and overlays). Use this when designing or building any product route, when reviewing a screen against v2, or when generating brand-consistent artefacts.
user-invocable: true
---

Read `readme.md` first — it names the source, what the v2 rebuild changed, and where the truth lives.

The mockup file has two forms in this folder:

- `maskin-app-v2.html` — the self-contained bundle. **Open this in a browser** to walk the mockup — it renders the whole app as it actually behaves (sidebar, top nav, every screen, menus, modals, overlays).
- `maskin-app-v2.dc.html` + `support.js` — the extracted `.dc` markup and its runtime. Does not render standalone (open the bundle above for that). Use it to jump straight to a component's markup by line number, using the map in `MOCKUP-INDEX.md`.

The v2 mockup covers **all fourteen product screens** — For you, Chats, Objects, Object detail, Loops, Trigger detail, Loop detail, New loop, Agents, Agent detail, Search, Marketplace, Marketplace detail, Settings — plus the sidebar/icon rail, the shared top nav, the command palette and create picker, the Stripe checkout and the edit-instructions modal. `MOCKUP-INDEX.md` maps every screen to its line range and its owning route. Build a screen against its own section; do not extrapolate from another one.

When building throwaway prototypes or slides, copy the tokens from `tokens/` and load the same two families listed in `tokens/fonts.css` (Schibsted Grotesk + JetBrains Mono).

When touching production code, `apps/web/src/app.css` already carries the v2 palette + radii + shadows and self-hosts the fonts under `apps/web/public/fonts/`. Go through the semantic classes (`bg-background`, `text-foreground`, `border-border`, `bg-brand`, `.eyebrow`) rather than importing this skill's CSS.
