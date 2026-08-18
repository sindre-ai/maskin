# v2 mockup — sections and where they land

The v2 file (`maskin-app-v2.html`) is a self-contained "bundled page" that ships **one prototype: the For You feed, v4**. Open the bundle in a browser to render it; read the markup by line using the extracted `maskin-app-v2.dc.html` (1071 lines) and its runtime `support.js`.

Line numbers in this document refer to `maskin-app-v2.dc.html`.

## What the file covers

The bundle's `__bundler/ext_resources` block references exactly one document: `Maskin For You - Feed v4.dc.html`. There are no other route mockups inside this file. What v2 does provide, alongside the fully mocked For You feed, is the **shared vocabulary** every route in the audit reads from — palette, radii, shadows, type, motion, and the reusable primitives (top nav, filter chips, cards, menu popovers, modal viewer).

## Sections in the .dc file

| Lines | Section | Owning bet | What it governs |
|---|---|---|---|
| 1–26     | `<helmet>` — fonts, base body styles, keyframes | App shell | Global font import, `Schibsted Grotesk` body font, `popUp` keyframe. Extract font pipeline from the shipped app, not this line — the shipped app self-hosts fonts under `apps/web/public/fonts/`. |
| 27–100   | Top nav row — per-view tabs, filter chips, `···` more menu | App shell | `components/layout/TopNav`. Tabs at 28px height, filter chips at 99px radius, 30×30 icon-only affordances at radius 9. |
| 61–99    | View menu popover — VIEW / SHOW / SORT sections | App shell | `components/layout/TopNav` menu overlay. 13px radius, 264px width, 6px padding, JetBrains Mono uppercase section headers at 8.5px `.11em` in `--ink-placeholder`. |
| 101–265  | Feed area — sections → groups → cards | For you feed | `routes/_authed/$workspaceId/index.tsx`. Reader column at `min(700px, 100%)` with `clamp(12px, 3vw, 28px)` inline padding. |
| 111–122  | Group header (grouped-card cluster) | For you feed | Sticky-at-top uppercase tag + title + bulk action ("Approve all", "Dismiss all") + open/closed count. |
| 124–247  | Feed card — row / full / collapsed states | For you feed | The reference for every dense list row in the app. `--r-card 12px`, 1px `--rule` border, 13–16px padding. Send/action affordance is a 30px circle at radius 999. |
| 249–263  | Section tail — dismissed / done / cleared states | For you feed | "Nothing older than four days" / "Feed cleared" / "Bring dismissed cards back" — the empty-state vocabulary for every list in the audit. |
| 266–296  | Modal viewer — post / mail / visual / body | App shell | Solid `rgba(24,24,27,.45)` backdrop, `min(560px, 100%)` sheet, radius 16, `--elev-modal`, `popUp .18s ease`. The pattern for every modal in the app (not just this feed). |
| 297–1070 | `<script>` — dc-runtime state + `Component` class | *(reference only)* | Fixture data + interaction glue. **Do not port** — the parent bet's "Not doing" is explicit about this. Read for behaviour intent (state transitions, filter semantics), not for wiring. |

## The 14 audit routes — where each one reads from

The parent bet's audit walks 14 routes. Only one of them has a route-specific v2 mockup; the rest apply the shared vocabulary (tokens + primitives) captured above. This is by design — the v2 file is one prototype, not fourteen.

| # | Route | Reads directly from | Notes |
|---|---|---|---|
| 1  | App shell               | 1–100, 266–296            | Top nav + modal viewer are the only shell surfaces in v2. Sidebar + rail + drawer + palette + create picker + toast are not in the mockup — build them against the same tokens and the same overlay conventions (solid `--overlay-dim` backdrop, `popUp` / `slideInR` / `slideInL` keyframes). |
| 2  | For you feed            | 101–263                   | The primary target of the mockup. Every state (empty, dismissed, grouped, collapsed, row, full) is in the file. |
| 3  | Chats                   | *(shared vocabulary)*     | Read from cards (124–247), row states (249–263) and the modal viewer (266–296). Chat thread rows are dense list rows; the "typing" indicator maps to `typedot` in `tokens/motion.css`. |
| 4  | Objects list & board    | *(shared vocabulary)*     | The 27–100 top nav row is the reference for filter chips + view menu; the card recipe (124–247) is the row density. Board columns reuse the group container (111–122) style. |
| 5  | Object detail           | *(shared vocabulary)*     | Modal viewer's post / mail / visual / body branches (266–296) are the reference for how "content type" changes reader affordance without changing the shell. |
| 6  | Loops list              | *(shared vocabulary)*     | Same list vocabulary as Objects — cards + top nav filters. |
| 7  | Loop detail             | *(shared vocabulary)*     | Reader column + modal viewer's body variant. |
| 8  | Trigger detail          | *(shared vocabulary)*     | Reader column + form controls at v2 densities (input height 30px, `--h-input`). |
| 9  | Agents list             | *(shared vocabulary)*     | Cards + top nav row. |
| 10 | Agent detail            | *(shared vocabulary)*     | Reader column + modal viewer + `orbitPulse` for the "working" dot (`tokens/motion.css`). |
| 11 | Marketplace list        | *(shared vocabulary)*     | Cards + top nav filters. |
| 12 | Marketplace item        | *(shared vocabulary)*     | Reader column. |
| 13 | Search + command palette| *(shared vocabulary)*     | Menu popover (61–99) is the reference; palette + create picker read the same conventions. |
| 14 | Settings (+ subs)       | *(shared vocabulary)*     | Reader column + form controls at v2 densities. Stripe checkout uses the modal viewer conventions. |

**How to file drift.** Walk each route against the section it reads from. If a route's implementation uses a colour, radius, shadow, or type value that isn't in `tokens/`, file a task on the owning view bet with the offending file path, the mockup line that governs it, and the drift. Page-local styling, off-scale spacing or type, palette or layout divergence from v2, or a pattern implemented twice — all count as drift.

## Not in scope

The bundle carries only one prototype; there is no v2 mockup for the other routes to port. If the audit turns up a route where the shared vocabulary is insufficient (e.g. a genuinely new pattern the v2 file does not cover), that is a signal to update this skill, not to invent a per-page style. Flag it on the parent bet.

The earlier warm-paper skill also carried the maskin.io site, an iOS mockup, a Knowledge v3 mockup, a Concepts prototype, and a First Use prototype. The parent bet excludes all of those (desktop web only) so they are not committed here. Ask if the audit wants any of them back.
