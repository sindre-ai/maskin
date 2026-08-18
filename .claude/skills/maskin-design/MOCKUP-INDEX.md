# v2 mockup — screens and where each one lands

`maskin-app-v2.dc.html` is the **full v2 app prototype**: one `data-app-root` shell containing all
fourteen product screens, gated by `sc-if` on a `v<Screen>` flag. It is flattened — the For You feed
(previously a separate `Maskin For You - Feed v4` document pulled in via `dc-import`) is inlined at
lines 280–516, so this one file is the complete reference. 9048 lines: **markup 1–3469**, **runtime
script 3470–9048**.

`maskin-app-v2.html` is the same prototype as a self-contained bundle — open it in a browser to
render it. Read the markup from the `.dc.html` by line; `support.js` is its dc-runtime.

> **This replaces the earlier index.** The previous version of this file described a bundle carrying
> *only* the For You feed v4 and stated "there is no v2 mockup for the other routes to port — the v2
> file is one prototype, not fourteen." That is no longer true. Every route below now has a
> route-specific mockup. Do not fall back to "shared vocabulary" for a screen that is listed here.

## How to read it

- **Screens are `sc-if` blocks**, one per `data-screen-label`. `<sc-for list="{{ x }}" as="y">` is a
  map; `{{ … }}` holes are bound in the script block. `style-hover="…"` is the hover state.
- **Read the markup for structure, spacing, and token values.** The script block (3470–9048) is
  fixture data plus a `Component` class — read it for *behaviour intent* (state transitions, filter
  semantics, empty-state conditions), never port it. Wiring goes through the app's real hooks.
- **Values that aren't in `tokens/` are drift.** The palette is cool zinc + indigo
  (`#18181b` ink, `#4f46e5` accent, `#f0f0f2` rules, `#b0b0b6` placeholder) — already encoded in
  `tokens/colors.css`. Note the `readme.md` in the *older upstream* design-system folder describes a
  warm-paper palette (`#111110` / `#FAFAF8` / `#2563EB`); that is the marketing site, not this app.

## The shell — shared by every screen

| Lines | Section | Owner |
|---|---|---|
| 39–119   | **Full sidebar**, 216px, `#fafafa` + 1px `#f0f0f2` right rule, 16px/12px padding. Workspace switcher (menu at 212px, radius 11, `0 10px 30px rgba(0,0,0,.12)`), primary nav list, secondary nav, dismissible release card, "agents working" card with pulsing 7px `#22c55e` dot + stacked 22px avatars, profile popover. | `layout/sidebar.tsx`, `workspace-switcher.tsx`, `sidebar-nav-item.tsx`, `nav-user.tsx` |
| 120–151  | **Icon rail** — the collapsed sidebar. 60px wide, 30px workspace tile, 32px nav tiles at radius 8, 6px unread dot, profile popover flies out to the right. | `layout/sidebar.tsx` (collapsed state) |
| 155–279  | **Shared top nav** — 44px min-height, 6px × `clamp(16px,4vw,44px)` padding, 1px bottom rule, wraps. Per-screen `<h1>` at `clamp(17px,2vw,20px)`/700/`-.02em` + a muted count. Then: workspace search (30px, collapses to an icon; `⌘K` chip opens the palette), per-screen actions (For You: Brief + Mark all read; Chats: filter menu; Loops: session `…` menu), a 1px divider, and the split **New** button (`#18181b`, radius 8, 24px caret half) opening a 290px menu — New chat, CREATE AN OBJECT list, workspace items, find-a-conversation. | `layout/top-nav.tsx`, `shared/new-menu.tsx`, `command-palette.tsx` |
| 3102–3469 | **Overlays** — mobile nav drawer, workspace menu, details sheet, command palette (`↑↓ navigate / ↵ run / ⌘↵ search everything / esc closes`), the create picker (`NEW` → pick a type → talk; "Maskin structured that into…" with PROPERTIES + ROUTING), voice capture ("Listening…"), the brief player, and toasts. | `command-palette.tsx`, `shared/create-picker.tsx`, `layout/mobile-nav.tsx` |

## The fourteen screens

| Lines | Screen | Route | What the mockup governs |
|---|---|---|---|
| 280–516   | **For you** | `$workspaceId/index.tsx` | The feed. Display menu (Cards / List) + SORT BY, card states (row / full / collapsed), `✦ SUMMARY` block, inline reply composer, `REC` voice chip, Keep-unread / Mark-as-read swipe affordances, "You chose · just now / Reverse this" undo, scroll-up-to-load, and the caught-up empty state ("Nothing needs you right now… Next brief tomorrow, 08:30"). | 
| 517–849   | **Chats** | `$workspaceId/chats/*` | Conversation list + thread. `IN THIS CHAT` participants popover, `ADD SOMEONE — PERSON OR AGENT`, copy-link / invite-by-email, `PICKING UP WHERE YOU LEFT OFF` resume banner, `YOU ATTACHED` / `REFERENCED` blocks, `REC` + Stop recording, the new-chat zero state ("What are we working on?"), and `TURN THIS INTO AN OBJECT`. |
| 850–1028  | **Objects** | `$workspaceId/objects/index.tsx` | List and Board. Bulk action bar (Approve / Hold selected / Status / Driver / Archive / Clear all), the Display menu (FILTER BY / GROUP BY / ORDER BY / SHOW IN LIST / Show archived / Reset to default), "Waiting on you" group, board `Drop here` target, `Show more`, and the filtered-empty state. |
| 1029–1502 | **Object detail** | `$workspaceId/objects/$objectId.tsx` | Breadcrumb + `⋯`, `SET STATUS`, `WHO DRIVES THIS` driver picker, the ask banner ("Answer it ↓"), pull-quote evidence, the Activity / Timeline / Related tabs, `Show all activity`, comment composers, and the properties sidebar (`driver` / `status` / `CUSTOM FIELDS` / `+ Add property` / `SUBSCRIBED` / `FILES`). |
| 1503–1578 | **Loops** | `$workspaceId/loops/index.tsx` | Loop rows + Display/Ordering menu, plus the two non-loop groups: **Not tied to a loop** ("workspace-wide automations that run on their own") and **Assigned in chat** ("work you handed an agent yourself — outside any cycle"). |
| 1579–1842 | **Trigger detail** | `$workspaceId/triggers/$triggerId.tsx` | A trigger outside a loop. `TRIGGER TYPE` / `SCHEDULE` / `WHEN TO FIRE` / `WHEN THIS HAPPENS` / `STATUS TRANSITION` / `ADDITIONAL CONDITIONS` (+ Add condition) / `WHERE IT LISTENS` / `DO THIS` (skill) / `USING THIS AGENT` / `WHAT IT WRITES` / `IT STOPS FOR YOU WHEN`, `RECENT RUNS`, `CHANGES`, and the language edit bar ("Say what should change — it edits the trigger above"). Inline `✓ Saved`. |
| 1843–2043 | **Loop detail** | `$workspaceId/loops/$loopId.tsx` | "Read it in four sentences, change it by talking." The loop-right-now summary with step filters, `Latest activity`, `Changes` with undo, the `PROPOSED EDIT` card (Make the change / Leave it — "nothing moves until you say so"), and the listening composer. Pre-first-run state: "Built from what you said — nothing has fired yet." |
| 2044–2286 | **New loop** | `$workspaceId/loops/new.tsx` | "Language is the only way in — no builder, no canvas." Prompt, the live blueprint (OBJECT TYPE → TRIGGER → AGENT with their one-line definitions), `OR START FROM ONE OF THESE` templates, the "Maskin only builds from language" gate, and the two empty states ("Nothing to draw yet. A loop needs a source it listens to and an end it reports to…"). |
| 2287–2343 | **Agents** | `$workspaceId/agents/index.tsx` | Agent cards + Display / Grouping / Ordering / Status menus. Empty states: "No agents in that state right now." and "Nobody on this team yet." |
| 2344–2521 | **Agent detail** | `$workspaceId/agents/$agentId.tsx` | `TEAM`, "Owns one outcome:", `USAGE` (tokens used, Budget, `TOKENS / MONTH`), Sessions + `Continue in chat` + `Full log`, `Loops it runs`, `Skills` / `Tools` (Manage), and `Instructions · system prompt` with Edit. |
| 2522–2573 | **Search** | `$workspaceId/search.tsx` | Page-level search across chats, loops, agents, objects, automations. `RECENT`, the no-match state ("Try a shorter word — or run a command instead" → `Open commands ⌘K`), and the zero state. |
| 2574–2606 | **Marketplace** | `$workspaceId/marketplace/index.tsx` | Catalog grid, `✓ Installed` state, filtered-empty state. |
| 2607–2716 | **Marketplace detail** | `$workspaceId/marketplace/$loopId/*` | `What it brings` ("everything installed in one go"), `What it will ask you for` ("the only places it stops for you"), `How it runs`, `Permissions`, install / `Remove from workspace`. |
| 2717–2954 | **Settings** | `$workspaceId/settings/*` | `WORKSPACE NAME`, `APPEARANCE`, `PRIVACY & DATA`, Members (`＋ Add member`), Integrations, Extensions, and Billing — `PLANS`, usage-at-cost copy, `Usage limit`, `PAYMENT METHOD`, `BILLING DETAILS`, `INVOICES`. |

## Two modals and one retired block

| Lines | What |
|---|---|
| 2955–3008 | **Inline rail — retired.** Marked in the mockup as superseded ("detail pages open directly"). Do not build. |
| 3009–3072 | **Stripe checkout** — Subscription / Included usage / Beyond that / Due today, `CARD INFORMATION`, `NAME ON CARD`, `COUNTRY`, `POSTAL CODE`, "Secured by Stripe. Maskin never sees or stores your card number." |
| 3073–3101 | **Edit instructions** modal — `EDITED` badge, "Running sessions finish on the old prompt. New sessions pick this up.", Reset to default / Cancel / Save. |

## How to file drift

Walk a route against its line range above. If the implementation uses a colour, radius, shadow, type
size, or spacing value that isn't in `tokens/`, or diverges structurally from the mockup, file a task
on the owning view bet naming **the file path, the mockup line, and the drift**. Page-local styling,
off-scale spacing or type, and a pattern implemented twice all count.

If a screen genuinely needs a pattern this file does not cover, that is a signal to update this skill
— not to invent a per-page style.

## Not in scope

Desktop web only. The upstream design folder also carries an iOS/iPhone prototype, an iPad prototype,
a Knowledge prototype, an Objects Redesign prototype, a First Use prototype, and the maskin.io
marketing site. None are committed here. Ask if a bet needs one.
