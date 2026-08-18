---
name: maskin-design
description: The v2 Maskin app design system — tokens, type, radii, shadows, motion, and component patterns extracted from Maskin App v2 Standalone.html (the For You feed prototype, v4). Use this when designing or building any product route, when reviewing a screen against v2, or when generating brand-consistent artefacts.
user-invocable: true
---

Read `readme.md` first — it names the source, what the v2 rebuild changed, and where the truth lives.

The mockup file has two forms in this folder:

- `maskin-app-v2.html` — the raw bundle the owner attached to the parent bet. **Open this in a browser** to walk the mockup — it renders the For You feed prototype as it actually behaves (filters, more menu, view menu, card states, modal viewer).
- `maskin-app-v2.dc.html` + `support.js` — the extracted `.dc` markup and its runtime. Does not render standalone (open the bundle above for that). Use it to jump straight to a component's markup by line number, using the map in `MOCKUP-INDEX.md`.

The v2 mockup fully covers the For You feed and the app's shared vocabulary (top nav, filter chips, cards, modal, menu popovers, tokens). Other routes do not have a v2 mockup of their own — they must apply the same tokens and reuse the same patterns. `MOCKUP-INDEX.md` calls out which routes read directly from a mockup section and which apply the shared vocabulary without a per-route mock.

When building throwaway prototypes or slides, copy the tokens from `tokens/` and load the same two families listed in `tokens/fonts.css` (Schibsted Grotesk + JetBrains Mono).

When touching production code, `apps/web/src/app.css` already carries the v2 palette + radii + shadows and self-hosts the fonts under `apps/web/public/fonts/`. Go through the semantic classes (`bg-background`, `text-foreground`, `border-border`, `bg-brand`, `.eyebrow`) rather than importing this skill's CSS.
