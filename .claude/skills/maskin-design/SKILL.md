---
name: maskin-design
description: The v2 Maskin app design system. Use this when designing or building any of the product routes, when reviewing a screen against the mockup, or when generating brand-consistent artefacts. Contains the v2 mockup (Maskin App v2 Standalone.html), tokens (colour, typography, spacing, shape, motion), and a section→route index.
user-invocable: true
---

Read `readme.md` first — it names what changed in v2 and where the truth lives.

For a specific screen, open `MOCKUP-INDEX.md`, find the section, then read `maskin-app-v2.html` around those lines. Do not port the mockup's inline styles or its `<sc-if>` bindings into the app — the v2 file is a `.dc` prototype, reference only. Build with the shared component library and the tokens in `tokens/`.

When building a static artefact (deck, throwaway prototype, marketing mock), read `tokens/` directly and load the same Google Fonts declared in `tokens/fonts.css` (Schibsted Grotesk, Newsreader italic, JetBrains Mono).
