# Maskin design system — v2

Maskin is an open-source, MCP-native system where a company's humans and AI agents work in one shared workspace. Everything flows through a single pipeline — **Insights → Bets → Tasks** — that people and agents read and write together. Agents post their work as comments on the objects they touch; humans approve bets; nothing ships without a human in the loop.

This skill exists so any Maskin surface — product screens, decks, docs, throwaway mocks — can be built without re-deriving the visual language.

## What v2 changed

The parent bet's owner decision on 2026-08-14 switched the design source of truth to `Maskin App v2 Standalone.html` and replaced the earlier warm-paper direction. This skill is the reference the v2 rebuild reads from — colours, radii, shadows, type, motion, and the shared component vocabulary all come out of this file.

Note on scope: the v2 file bundles **one prototype — the For You feed, v4**, packaged as a self-contained "bundled page." It fully specifies the For You route and, through its top-nav row, filter chips, card recipes, menu popovers and modal viewer, defines the shared vocabulary the other routes must reuse. The other routes do **not** have per-view v2 mockups; the audit walks them against the tokens and patterns extracted from this file. `MOCKUP-INDEX.md` names which routes read from a specific section and which extrapolate.

Key deltas from the earlier warm-paper direction:

- **Palette is cool zinc + indigo.** The warm ink/paper/blue set (`#111110` / `#FAFAF8` / `#2563EB`) is gone. v2 uses zinc-950 `#18181b` on white with `#4f46e5` indigo as the single accent, straight from Tailwind's zinc + indigo scales. The dark-mode swap inverts the neutral ramp and shifts indigo one step lighter (`#818cf8`). Full palette in `tokens/colors.css`.
- **Two type families, not three.** Schibsted Grotesk (variable 400–900) does every screen and every block of running text. JetBrains Mono (400/500/600/700) marks machine-shaped text: uppercase micro-labels, ids, counts, cron. **Newsreader is not used** in v2 — the italic-serif register the v1 doc reserved for pull-quotes does not appear in this mockup and is not loaded.
- **Density is tighter.** v2's mockup uses a dense pixel set (8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 19, 22 px). Body copy sits at 13/1.55. Half-step sizes are intentional — do not round them away.
- **Motion is limited to six named keyframes** (`fadeIn`, `popUp`, `slideInR`, `slideInL`, `orbitPulse`, `micPulse`, `eq`, `typedot`, `mkSpin`). Everything else is a transition. All motion is disabled under `prefers-reduced-motion`.
- **Overlays are solid, not frosted.** No glass, no backdrop-blur on cards. The modal viewer opens on a solid `rgba(24,24,27,.45)` backdrop; the sole dark surface is the `#3f3f46` "Today's brief" pill on For You. Do not re-introduce translucent surfaces.

## Sources

| Source | What was taken from it |
|---|---|
| `Maskin App v2 Standalone.html` (attached to the parent bet; mirrored here as `maskin-app-v2.html`) | **The visual language.** Tokens, type scale, colour, shape, motion, component patterns, the For You feed layout, overlays, modal viewer. Its inline CSS + inline styles + the `Component` class in the trailing `<script>` are the derivation source for every value in `tokens/`. Extracted to `maskin-app-v2.dc.html` + `support.js` for line-based reading. |
| `github.com/sindre-ai/maskin` (`apps/web/src`) | **The product surface inventory.** React + TanStack Router + Tailwind 4 + shadcn/ui (Radix primitives) + lucide-react. Used to enumerate the shipped routes and the component library the rebuild targets. |

The earlier warm-paper skill also carried the maskin.io site as a source and four adjacent prototypes (iOS, Knowledge, Concepts, First Use). Those are out of scope — the parent bet excludes them (desktop web only, v2 replaces the site as the product source).

## Voice

Unchanged — the design system reads the same product.

- **A blunt operator, not a vendor.** Short declaratives. Contrast sentences that name the lazy answer and then correct it — "Those share prompts. Maskin shares state."
- **Claims are concrete and checkable.** "One `docker-compose` file." "$20/seat/month." Never "seamless", "revolutionary", "10x".
- **Domain nouns are load-bearing and capitalised as objects:** Insight, Bet, Task, Knowledge, Loop, Trigger, Agent, Session, Workspace.
- **Agent copy is third-person and attributed:** "Quill asks — Customer-facing dunning copy changes." Never let an agent speak as "I".
- **Human-in-the-loop language is a promise, not a bullet:** "Nothing deploys without a human in the loop."
- **Micro-labels are uppercase**, tracked `.11em`, set in JetBrains Mono at 8.5–9px, coloured `--ink-placeholder` — describe a stage or kind (MENTIONED, VIEW, SORT, SHOW).
- **Mono for anything machine-shaped:** ids, statuses, object types, cron strings, counts.
- **No emoji.** Anywhere. Arrows (→, ‹, ›, ↵, ⌃, ⌄), em dashes, and small unicode glyphs carry any flourish.

## Visual foundations

The tokens live in `tokens/`. This section describes how they compose.

### Colour

- **Foreground stack** — five ink steps on white. `--ink #18181b` (zinc-950) is the primary text colour. Body copy uses `--ink-3 #52525b` (zinc-600); meta and disabled state slide down through `--ink-4 #71717a`, `--ink-5 #a1a1aa`, `--ink-placeholder #b0b0b6`. Anything visible at rest sits on the darker three steps; only meta and placeholders touch the lighter two.
- **Surface stack** — white for cards; `--surface-muted #fafafa` for the app page; `--surface-alt #f4f4f5` for sunken bands and rounded chip fills; `--surface-hover #f0f0f2` and `--surface-hover-2 #ececee` for interactive hovers. `--surface-strong #3f3f46` is the **only** dark surface in the light theme — v2 uses it for the "Today's brief" pill on For You and for the modal viewer's dismissed state, both of which reverse to a light foreground on that dark plate.
- **Rules** — `--rule #ececee` is the standard 1px hairline for cards, inputs, list rows and internal dividers. `--rule-2 #f0f0f2` is a quieter internal separator (used inside a menu popover). `--rule-strong #c4c4cc` is the hover/promotion state on an interactive element. `--rule-input #e4e4e7` is the resting outline on inputs and the `···` more button. Rules always take 1px in v2 — 1.5px is reserved for focus and the coloured card top-rule (see Cards).
- **Accent** — one colour: indigo-600 `--accent #4f46e5`. It marks **what is live or what to click**. Never a large fill, never a background band. Two tints, `--accent-tint #e0e7ff` and `--accent-tint-2 #eef2ff`, appear on quiet chips and the "you" avatar. Hover on the accent slides to `--accent-strong #4338ca`; on an accent link, hover goes to `--accent-deep #3730a3`. The four `--accent-fg-*` tokens are reserved for text-on-a-dark-surface (dark-toast action colours).
- **Semantic** — green `--success #16a34a` (with `--success-tint #dcfce7`) for shipped/OK; amber `--warning #d97706` (with `--warning-tint #fef3c7`) for awaiting/needs sign-off; red `--danger #dc2626` for destructive; sky `--info #0ea5e9` for a rare info dot. The mic-record pulse uses `--danger-mic #ef4444` at 50% alpha because it's a keyframe ring, not text.
- **Object-type dots** — five hues sit outside the neutral trunk. `--obj-doc #94a3b8`, `--obj-insight #fbbf24`, `--obj-bet #f59e0b`, `--obj-task #22c55e`, `--obj-knowledge #7c3aed`. These are used only as 8–10px dots or 3px card top-rules — never as fills, never as text.
- **Agent identity** — five agent avatars (Relay, Compass, Forge, Sentinel, Quill) each carry a tint / foreground pair plus a strong version for the "streaming" state. See `--agent-*` tokens. Application code should use `AVATAR_PALETTE` from the shipped React library; these tokens are declared here only so a designer can mock the same character in HTML.
- **Dark mode** is a full token swap driven by `prefers-color-scheme` with a `[data-theme]` override. The zinc scale inverts; the accent lightens one step to `#818cf8`. Every UI surface must read from tokens — no component may hardcode a hex in either theme. The v2 mockup is light-only; the dark values in `colors.css` are the derived swap. Verify contrast in dark before shipping.

### Type

Two families, from `tokens/typography.css`.

- **Schibsted Grotesk** (variable 400–900) is the UI font — every screen, every component, every block of running text.
- **JetBrains Mono** (400/500/600/700) marks machine-shaped text: uppercase micro-labels, ids, counts, cron, meta.

v2 sits on a dense fixed pixel set — 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 19, 22. Body copy is 13/1.55. Section headings are 700 with `-.015em` tracking; the page-level headline is 700/1.35 at 22 with `-.02em`. Uppercase micro-labels are 700 at 8.5–9px in JetBrains Mono with `.11em` tracking, coloured `--ink-placeholder`. Half-step sizes exist because the mockup uses them; do not round them.

### Layout

- **Reader column.** The v2 feed centres a column at `width: min(700px, 100%)`; the shell inline padding is `clamp(12px, 3vw, 28px)`. Long-form surfaces in the audit (For You, Object detail, briefs) inherit the same reader column.
- **App shell.** In the shipped app the shell is a 260px sidebar (`--sidebar-w`) on the left over the reader column; the sidebar collapses to a 52px icon rail (`--iconrail-w`), and on mobile becomes a drawer (`--mobile-drawer-w = min(320px, 88vw)`). The v2 mockup renders the reader column embedded (no shell around it) — those shell constants are derived from the shipped app, not the mockup.
- **Cards** are 12–14px radius, 1px `--rule` border, white background, 12–14px padding. A group card takes 14px radius; a nested feed card takes 12px. Hover: border → `--rule-strong`, `translateY(-1px)`, `--elev-hover`. A card can carry a coloured 3px top rule to signal its type; that is the only place colour touches a container edge.
- **Chips** — two flavours. Quiet: `--surface-alt` fill, 1px `--rule` border, `--ink-3` text. Accent: `--accent-tint` fill, `--accent-fg-strong` text. The v2 feed's per-type filter chips are 28px tall (`--h-tab`), 99px radius, `.75rem` inline padding, and carry a mono count on the right.
- **Menu popovers** — 13px radius (`--r-card-lg`), 250–264px width, 6px inner padding, `--elev-hover` shadow, `popUp .15s ease` reveal, JetBrains Mono uppercase section headers ("VIEW", "SHOW", "SORT") at 8.5px `.11em` in `--ink-placeholder`.
- **Buttons** — primary is `--ink` fill, white text, 1px `--ink` border, `--r-btn 8px`, weight 600. Secondary is transparent with 1px `--rule-input`, weight 500. Ghost is `--ink-3` text only. Icon-only affordances are 30×30 with radius 9px (`--r-btn-lg`).
- **Elevation** — cards use `--elev-hover 0 4px 16px rgba(0,0,0,.07)` on hover; the modal viewer uses `--elev-modal 0 24px 70px rgba(0,0,0,.3)`. Menu popovers use `0 12px 34px rgba(0,0,0,.1)`. No inner shadows. No glows.

### Modal viewer (the only overlay in the v2 file)

The v2 mockup ships one overlay — the modal viewer for expanding a feed card into a fuller reader (post / mail / visual / body). It uses a solid `rgba(24,24,27,.45)` backdrop with 24px inset padding, centred content at `min(560px, 100%)`, 16px radius, `--elev-modal`, and reveals with `popUp .18s ease`. Escape closes; clicking the backdrop closes; clicking inside the sheet does not close (see `eatClick` in `support.js`).

Other app-shell overlays (mobile nav drawer, command palette, create picker, toast) are not in this mockup. When building them, keep the same backdrop colour and the `popUp` / `slideInR` / `slideInL` keyframes; the overlay-dim token is `rgba(0,0,0,.35)` for the shell drawers and `rgba(24,24,27,.45)` for the modal viewer.

### Motion

Fast and small. See `tokens/motion.css` — the keyframes are the entire vocabulary:

- `fadeIn 180–200ms ease` — overlay backdrops, brief drawer.
- `popUp .15s–.2s ease` — menu popovers, modal viewer.
- `slideInR / slideInL 300ms` — drawers.
- `orbitPulse 1.2s ease-in-out infinite` — "an agent is working" dot.
- `micPulse 1.2s ease-in-out infinite` — mic recording ring.
- `eq` — audio waveform equaliser bars.
- `typedot` — three-dot typing indicator.
- `mkSpin` — spinner (rare; use a skeleton on large areas instead).

Transitions: `--dur-150` on colour/border, `--dur-200` on shadow + transform, `--dur-250` on nav/panel state. The universal hover is `translateY(-1px)`. Everything is disabled under `prefers-reduced-motion` via the `@media` block in `motion.css`.

### Empty and loading

Empty states use the same vocabulary as cards — a 12–14px-radius card with `--rule` border, a title in `--ink`, a body in `--ink-3`, and one primary action. The v2 mockup's dismissed-cards tail is the reference pattern: a centred "Nothing older than four days" / "Feed cleared" / "Nothing of this kind in the feed" line with a "Bring dismissed cards back" ghost link. Loading uses skeleton blocks in `--surface-alt` — never spinners on large areas. Small "working…" indicators may use `mkSpin` at 12–16px.

## Iconography

- **Product app:** `lucide-react`. 16px in dense UI, 20px in headers, `stroke-width: 2`, `currentColor`, round caps.
- **Marketing / decks / throwaway mocks:** Lucide from CDN (`lucide@latest`), same stroke-width and caps. Do not hand-draw icons; do not mix icon sets.
- **Icon containers:** 30–32px square, `--surface` fill with 1px `--rule-input` border, radius 9px (`--r-btn-lg`). Glyph in `--ink-4` at rest, `--ink` on hover.
- **Unicode as icons** is idiomatic and used deliberately: `→` for progression, `‹` `›` for back/forward, `↵` for enter, `⌃` `⌄` for expand/collapse, `···` for overflow, `✓` for check, `✕` for dismiss. **No emoji, ever.**
- **Logo.** A single open stroke drawn as an M — `M22 56 L22 26 L40 46 L58 26 L58 56` on a 64×64 tile with 12px radius (thumbnail) or 80×80 with 14px radius (full). Stroke `--surface`, `stroke-width: 7` (thumbnail) or `10` (nav), square caps, mitre joins. Tile fills to `#18181b` in light mode and to `--surface-alt` in dark mode; stroke follows the corresponding surface colour. Wordmark is "Maskin" in Schibsted Grotesk 700 at `-.02em`. The name is Norwegian for *machine*.

## Component inventory

The v2 mockup renders the For You feed's patterns in full. Enumerated from the mockup plus `apps/web/src/components/` in the shipped app:

- **In the v2 mockup (line refs in `MOCKUP-INDEX.md`)** — top nav row (tabs + filter chips + `···` more menu + view menu + settings icon), grouped-card container, feed card (row / full / collapsed / done), send affordance, dismissed tail, modal viewer (post / mail / visual / body).
- `components/ui/` (shadcn / Radix primitives) — Button, ButtonGroup, Input, Textarea, Label, Select, Checkbox, RadioGroup, Switch, Badge, Card, Separator, Tabs, Table, Tooltip, Popover, DropdownMenu, Dialog, Sheet, Breadcrumb, Calendar, Collapsible, Skeleton, Spinner.
- `components/objects/` — TypeBadge, StatusBadge, ObjectReference, MetadataBadges, VerifiedChip, LoopCard, BetCard, LinkedObjects, RelatedObjectsTable, BulkActionBar, PropertySelect, FieldValueInput.
- `components/activity/` — ActivityComment, ActivityItem, ActionBanner, PhaseDivider, DecisionChips, RelationshipNode, CommentInput, UndoWriteChip, PendingCommentRow, MentionSessionCard, StreamingIndicator.
- `components/agents/` — ActorAvatar, AgentPulse, AgentWorkingBadge, AgentPortraitCard, SessionLogTranscript, SessionDetailPanel, RunPauseButton.
- `components/shared/` — FilterChip, FilterTabs, IndicatorBadge, UnreadBadge, SourceBadge, EmptyState, LoadingSkeleton, RelativeTime, AttachedFileCard, UploadProgress, SubscribeToggle, CreatePicker, DateRangePicker, MarkdownContent, MentionedText, OfflineBanner, FormError.
- `components/layout/` — Sidebar, SidebarActivity, WorkspaceSwitcher, NavUser, Header, PageHeader, TopNav, CommandPalette.

## Index

| Path | What |
|---|---|
| `maskin-app-v2.html` | The bundled v2 mockup — open in a browser to walk it side-by-side. |
| `maskin-app-v2.dc.html` + `support.js` | The extracted `.dc` markup + runtime. Read the markup by line using `MOCKUP-INDEX.md`. Does not render standalone — open the bundle above for that. |
| `MOCKUP-INDEX.md` | Section → route/component map. Start here when reviewing a screen. |
| `tokens/colors.css` | Zinc + indigo palette, semantic, object-type, and agent-identity tokens; dark-mode swap. |
| `tokens/typography.css` | Families, weights, dense size scale, line-heights, tracking, and named recipes. |
| `tokens/spacing.css` | The dense v2 scale + layout constants + touch targets + control heights. |
| `tokens/shape.css` | Radii by intent, border weights, elevation. |
| `tokens/motion.css` | Named keyframes + durations + easings + reduced-motion block. |
| `tokens/fonts.css` | Google Fonts CDN import for the two v2 families. |
| `SKILL.md` | Skill entry point. |
| `github.md` | Repo association + sync log. |

## Intentional additions

None. Every token value is lifted verbatim from `maskin-app-v2.html`; nothing is rounded to a 4/8px grid. If the mockup uses `11.5px`, this system carries `11.5px` — do not round it away.
