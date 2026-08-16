# Maskin design system — v2

Maskin is an open-source, MCP-native system where a company's humans and AI agents work in one shared workspace. Everything flows through a single pipeline — **Insights → Bets → Tasks** — that people and agents read and write together. Agents post their work as comments on the objects they touch; humans approve bets; nothing ships without a human in the loop.

This skill exists so any Maskin surface — product screens, decks, docs, throwaway mocks — can be built without re-deriving the visual language.

## What v2 changed

The parent bet's owner decision on 2026-08-16 replaced the v1 mockup with `Maskin App v2 Standalone.html`. The v2 file is now the sole visual source of truth for the 14 product routes — layout, colour, typography, navigation, motion. Round 1 of the rebuild had shipped without this file being used; the v2 pass rebuilds against it.

Key deltas from v1:

- **Top navigation is replaced.** The v1 warm-paper marketing nav is gone. v2 uses a per-view top bar with view-specific tabs, filters and an inline search / "New" menu — never a persistent horizontal marketing nav.
- **Palette is cool zinc + indigo, verbatim from Tailwind.** v1 was warm paper (`--ink #111110`, `--surface #FAFAF8`, blue `#2563EB`); v2 uses zinc-950 `#18181b` on white with `#4f46e5` indigo as the single accent. The warm palette no longer describes anything in the product — it applies only to the marketing site.
- **Type stays the same three families, different mix.** Schibsted Grotesk everywhere; Newsreader italic reserved for a single pull-quote; JetBrains Mono for uppercase micro-labels, ids, counts, meta. The v1 "Newsreader for prose" register is gone — v2 uses Schibsted Grotesk for every block of running text.
- **Density is tighter.** v2 uses 8, 9, 9.5, 10.5, 11.5, 12.5, 13, 13.5, 14, 16, 17, 19, 22 px sizes — a much denser scale than v1's clamp-based `--step-0…4`. Body copy sits at 13/1.55.
- **Motion is limited to six named keyframes** (`fadeIn`, `popUp`, `slideInR/L`, `orbitPulse`, `micPulse`, `eq`, `typedot`, `mkSpin`). Anything else is a drift.
- **Overlays share one backdrop.** `overlayOpen` renders a single 35%-black fixed backdrop; every drawer/modal/palette/create-picker/toast opens on top of it. No component may add its own backdrop.

If you saw a copy of the v1 design system doc (`readme.md` on the `claude/maskin-design-implementation-mbxk1s` branch), treat it as historical. This file supersedes it. Where the two disagree, v2 wins.

## Sources

| Source | What was taken from it |
|---|---|
| `Maskin App v2 Standalone.html` (attached to the parent bet, mirrored in this folder as `maskin-app-v2.html`) | **The whole visual language for the product.** Tokens, type scale, colour, shape, motion, component patterns, section layouts, overlays. Read this before making a visual decision. |
| `github.com/sindre-ai/maskin` (`apps/web/src`) | **The product surface inventory.** React + TanStack Router + Tailwind 4 + shadcn/ui (Radix primitives) + lucide-react. Used to enumerate the shipped 14 routes and the component library the rebuild targets. |

The v1 skill also carried a marketing-site source (`sources/maskin.io/`) and four other prototypes (iOS, Knowledge, Concepts, First Use). Those were left out of v2 deliberately — the parent bet's "Not doing" excludes them (desktop web only).

## Voice

Unchanged from v1 — the design system reads the same product.

- **A blunt operator, not a vendor.** Short declaratives. Contrast sentences that name the lazy answer and then correct it — "Those share prompts. Maskin shares state."
- **Claims are concrete and checkable.** "One `docker-compose` file." "$20/seat/month." Never "seamless", "revolutionary", "10x".
- **Domain nouns are load-bearing and capitalised as objects:** Insight, Bet, Task, Knowledge, Loop, Trigger, Agent, Session, Workspace.
- **Agent copy is third-person and attributed:** "Quill asks — Customer-facing dunning copy changes." Never let an agent speak as "I".
- **Human-in-the-loop language is a promise, not a bullet:** "Nothing deploys without a human in the loop."
- **Micro-labels are uppercase**, tracked `.11em`, set in JetBrains Mono at 9px, coloured `--ink-placeholder` — describe a stage or kind (MENTIONED, REPLIES, NEEDS YOU).
- **Mono for anything machine-shaped:** ids, statuses, object types, cron strings, counts.
- **No emoji.** Anywhere. Arrows (→, ‹, ›, ↵), em dashes, and the italic serif carry any flourish.
- **Italic serif is the only flourish** — Newsreader italic, one line at a time.

## Visual foundations

The tokens live in `tokens/`. This section describes how they compose.

### Colour

- **Foreground stack** — five ink steps on white. `--ink #18181b` is the primary text colour. Body copy uses `--ink-3 #52525b`; meta and disabled state slide down through `--ink-4 #71717a`, `--ink-5 #a1a1aa`, `--ink-placeholder #b0b0b6`. Anything visible at rest sits on the darker three steps; only meta and placeholders touch the lighter two.
- **Surface stack** — white for cards; `--surface-muted #fafafa` for the app page; `--surface-alt #f4f4f5` for sunken bands and rounded chip fills; `--surface-hover #f0f0f2` and `--surface-hover-2 #ececee` for interactive hovers. `--surface-strong #3f3f46` is the *only* dark surface in the light theme — v2 uses it for the "Today's brief" pill on For You and for the toast, both of which reverse to a light foreground on that dark plate.
- **Rules** — `--rule #ececee` is the standard 1px hairline for cards, inputs, list rows and internal dividers. `--rule-2 #f0f0f2` is a quieter internal separator (used inside a menu). `--rule-strong #c4c4cc` is the hover/promotion state on an interactive element. Rules always take 1px in v2 — the v1 signature 1.5px is not used except on active card top-borders (see Cards).
- **Accent** — one colour: indigo-600 `--accent #4f46e5`. It marks *what is live or what to click*. Never a large fill, never a background band. Two tints, `--accent-tint #e0e7ff` and `--accent-tint-2 #eef2ff`, appear on quiet chips and the "you" avatar. Hover on the accent slides to `--accent-strong #4338ca`; on an accent link, hover goes to `--accent-deep #3730a3`. The four `--accent-fg-*` tokens are reserved for text-on-a-dark-surface (the toast's action link is `--accent-fg-quietest #a5b4fc` → hover `--accent-fg-quietest-2 #c7d2fe`).
- **Semantic** — green `--success #16a34a` (with `--success-tint #dcfce7`) for shipped/OK; amber `--warning #d97706` (with `--warning-tint #fef3c7`) for awaiting/needs sign-off; red `--danger #dc2626` for destructive; sky `--info #0ea5e9` for a rare info dot. The mic-record pulse uses `--danger-mic #ef4444` with 50%-alpha because it's a keyframe ring, not text.
- **Object-type dots** — five hues sit outside the neutral trunk. `--obj-doc #94a3b8`, `--obj-insight #fbbf24`, `--obj-bet #f59e0b`, `--obj-task #22c55e`, `--obj-knowledge #7c3aed`. These are used only as 8-10px dots or 3px card top-rules — never as fills, never as text.
- **Agent identity** — five agent avatars (Relay, Compass, Forge, Sentinel, Quill) each carry a tint / foreground pair plus a strong version for the "streaming" state. See `--agent-*` tokens. Application code should use `AVATAR_PALETTE` from the shipped React library; these tokens are declared only so a designer can mock the same character in HTML.
- **Dark mode** is a full token swap driven by `prefers-color-scheme` with a `[data-theme]` override. The zinc scale inverts; the accent lightens one step to `#818cf8`. Every UI surface must read from tokens — no component may hardcode a hex in either theme. (v2's mockup is light-only; the dark values in `colors.css` are the derived swap. Verify contrast in dark before shipping.)

### Type

Three families, from `tokens/typography.css`.

- **Schibsted Grotesk** (400–900) is the UI font — every screen, every component, every block of running text.
- **Newsreader italic** (400/500/600) is reserved for a single pull-quote or one-line flourish. Never a running paragraph.
- **JetBrains Mono** (400/500/600) marks machine-shaped text: uppercase micro-labels, ids, counts, cron, meta.

v2's UI sizes are a dense fixed set — `text-8` through `text-22` px, with half-step sizes at 9.5, 10.5, 11.5, 12.5, 13.5. Body copy is 13/1.55. Headlines are 700 with `-.015em` tracking; screen headings are 700/1.35. Uppercase micro-labels are 700 at 9px in JetBrains Mono with `.11em` tracking, coloured `--ink-placeholder`.

Prose in a brief runs 13/1.7 in `--ink-2`. The one pull-quote uses `.type-quote` (17px Newsreader italic 500/1.5).

### Layout

- **App shell** is a two-column layout: a 260px sidebar on the left (`--sidebar-w`), an app canvas on the right. On narrower canvases the sidebar collapses to a 52px icon rail (`--iconrail-w`); on mobile it becomes a drawer (`--mobile-drawer-w = min(320px, 88vw)`), opened from a header hamburger via `navOpen`. The top nav is a per-view bar 56px tall (`--topnav-h`), with view-specific tabs, filters and an inline search + "New" menu — never a persistent horizontal marketing nav.
- **Inline padding** on the page shell is `--gap-page: clamp(12px, 3vw, 28px)`.
- **Cards** are 12px radius, `--rule` 1px, white background, 12–14px padding. A card can carry a `1.5px` coloured top border to signal its category — the only place colour touches a container edge. Hover: border → `--rule-strong`, `translateY(-1px)`, `--elev-hover`.
- **Chips** — two flavours. Quiet: `--surface-alt` fill, `1px --rule` border, `--ink-3` text. Accent: `--accent-tint` fill, `--accent-fg-strong` text. Both sit at `--r-card` on the mockup's dense chip rows, `--r-round` on prompt-bar chips. Mono chips for object types use a 5% or 10% tint of their own hue at `--r-input-sm 5px` with no border.
- **Buttons** — primary is `--ink` fill, white text, `1px --ink` border, `--r-btn 8px`, weight 600, `8px 14px`. Secondary is transparent with `1px --rule`, weight 500. Ghost is `--ink-3` text only. The one accent-filled control in v2 is the mic recording button (kept indigo because it maps to the sole live/click role); everything else uses ink or transparent.
- **Elevation** — cards use `--elev-hover 0 4px 16px rgba(0,0,0,.07)` on hover; the toast + modal drawer use `--elev-modal 0 8px 24px rgba(0,0,0,.25)`. No inner shadows. No glows.

### Overlays

Every overlay renders behind a single 35%-black backdrop (`--overlay-dim`, `overlayOpen`). Four overlays share it:

- **Mobile nav drawer** (`navOpen`) — slides in from the left, `--mobile-drawer-w`, `slideInL 300ms`.
- **Command palette** (`paletteOpen`) — centered, `--palette-w`, `popUp .2s ease`. Palette rows use a 22px `--r-input-sm 5px` glyph tile. Also the entry surface for the Search bet.
- **Create picker** (`newOpen`) — right-aligned under the top nav, `--new-picker-w`, `popUp .2s ease`. Greeter → quick-add → typed preview.
- **Toast** (`toast`) — bottom-center, `--surface-strong` fill, `--r-pill 99px`, `popUp .2s ease`, max-width `88vw`. Toast actions are `--accent-fg-quietest` → `--accent-fg-quietest-2` on hover.

The Stripe checkout overlay (`payOpen`) and the edit-instructions overlay (`aeOpen`) are page-scoped drawers, not app-shell overlays — they open with their own state flag inside Settings and Agent detail respectively.

### Motion

Fast and small. See `tokens/motion.css` — six named keyframes are the entire vocabulary:

- `fadeIn 180–200ms ease` — overlay backdrops, brief drawer.
- `popUp .2s ease` — toast, palette, create picker.
- `slideInR / slideInL 300ms` — right-hand panel, mobile drawer.
- `orbitPulse 1.2s ease-in-out infinite` — "an agent is working" dot.
- `micPulse 1.2s ease-in-out infinite` — mic recording ring.
- `eq` — audio waveform equaliser bars.
- `typedot` — three-dot typing indicator.
- `mkSpin` — spinner (rare — only for a small "working…" indicator; use a skeleton on large areas instead).

Everything else is a transition: `--dur-150` on colour/border, `--dur-200` on shadow + transform, `--dur-250` on nav/panel state. The universal hover is `translateY(-1px)`. Everything is disabled under `prefers-reduced-motion` via the `@media` block in `motion.css`.

### Empty and loading

Empty states use the same linen-and-hairline vocabulary as cards — a 12px-radius card with `--rule` border, a title in `--ink`, a body in `--ink-3`, and one primary action. Loading uses skeleton blocks in `--surface-alt` — never spinners on large areas. Small "working…" indicators may use `mkSpin` at 12–16px.

## Iconography

- **Product app:** `lucide-react`. Keep it — 16px in dense UI, 20px in headers, `stroke-width: 2`, `currentColor`, round caps.
- **Marketing / decks / throwaway mocks:** Lucide from CDN (`lucide@latest`), same stroke-width and caps. Do not hand-draw icons; do not mix icon sets.
- **Icon containers:** 32px square, `--surface-alt` or `--surface` fill, `1px --rule` border, `--r-btn 8px`. Glyph in `--ink-3` at rest, `--ink` on hover.
- **Unicode as icons** is idiomatic and used deliberately: `→` for progression, `‹` `›` for back/forward, `↵` for enter, `⋯` `…` for overflow, `✓` for check (in `--accent`), `✕` for dismiss. **No emoji, ever.**
- **Logo.** A single open stroke drawn as an M — `M22 56 L22 26 L40 46 L58 26 L58 56` on a 64×64 tile with 12px radius (thumbnail) or 80×80 with 14px radius (full). Stroke `--surface`, `stroke-width: 7` (thumbnail) or `10` (nav), square caps, mitre joins. Tile fills to `#18181b` in light mode and to `--surface-alt` in dark mode; stroke follows the corresponding surface colour. Wordmark is "Maskin" in Schibsted Grotesk 700 at `-.02em`. The name is Norwegian for *machine*.

## Component inventory

The v2 mockup renders every pattern the 14 routes use. Enumerated from `apps/web/src/components/` in the shipped app plus the v2 markup:

- `components/ui/` (shadcn / Radix primitives) — Button, ButtonGroup, Input, Textarea, Label, Select, Checkbox, RadioGroup, Switch, Badge, Card, Separator, Tabs, Table, Tooltip, Popover, DropdownMenu, Dialog, Sheet, Breadcrumb, Calendar, Collapsible, Skeleton, Spinner.
- `components/objects/` — TypeBadge, StatusBadge, ObjectReference, MetadataBadges, VerifiedChip, LoopCard, BetCard, LinkedObjects, RelatedObjectsTable, BulkActionBar, PropertySelect, FieldValueInput.
- `components/activity/` — ActivityComment, ActivityItem, ActionBanner, PhaseDivider, DecisionChips, RelationshipNode, CommentInput, UndoWriteChip, PendingCommentRow, MentionSessionCard, StreamingIndicator.
- `components/agents/` — ActorAvatar, AgentPulse, AgentWorkingBadge, AgentPortraitCard, SessionLogTranscript, SessionDetailPanel, RunPauseButton.
- `components/shared/` — FilterChip, FilterTabs, IndicatorBadge, UnreadBadge, SourceBadge, EmptyState, LoadingSkeleton, RelativeTime, AttachedFileCard, UploadProgress, SubscribeToggle, CreatePicker, DateRangePicker, MarkdownContent, MentionedText, OfflineBanner, FormError.
- `components/navigation/` — Sidebar, SidebarActivity, WorkspaceSwitcher, NavUser, Header, PageHeader, CommandPalette.
- `components/chat/` — ChatList, ChatThread, TypingIndicator, StreamingCaret, ChatFilterMenu, ChatEmpty, ChatCreatePrompt.
- `components/loops/` — LoopSummary, LoopBlueprint, NewLoopBuilder (conversation + blueprint), TriggerSummary.

## Index

| Path | What |
|---|---|
| `maskin-app-v2.html` | The v2 mockup — open in a browser to walk it side-by-side. |
| `MOCKUP-INDEX.md` | Section → route map. Start here when reviewing a screen. |
| `tokens/colors.css` | The zinc + indigo palette, semantic, object-type, and agent-identity tokens; dark-mode swap. |
| `tokens/typography.css` | Families, weights, size scale, line-heights, tracking, and named recipes. |
| `tokens/spacing.css` | The 4/6/8/10/12/14 px scale + layout constants + touch targets + control heights. |
| `tokens/shape.css` | Radii by intent, border weights, elevation. |
| `tokens/motion.css` | Six named keyframes + durations + easings + reduced-motion block. |
| `tokens/fonts.css` | Google Fonts imports for the three families. |
| `SKILL.md` | Skill entry point. |
| `github.md` | Repo association + sync log. |

## Intentional additions

None. Every value in `tokens/` is lifted verbatim from `maskin-app-v2.html`; nothing is rounded to a 4/8px grid. If the mockup uses `11.5px`, this system carries `11.5px` — do not round it away.
