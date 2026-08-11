# Maskin Design System

Maskin is an open-source, MCP-native system where a company's humans and AI agents work in
one shared workspace. Everything flows through a single pipeline — **Insights → Bets → Tasks**
— that people and agents read and write together. Agents post their work as comments on the
objects they touch; humans approve bets; nothing ships without a human in the loop.

This design system exists so new Maskin surfaces (product screens, decks, docs, marketing pages)
can be designed on-brand without re-deriving the visual language each time.

## Sources

| Source | What was taken from it |
|---|---|
| `github.com/vaerksted-ai/maskin.io` (branch `main`) | **The look and feel.** Tokens, type scale, colour, shape, motion, component patterns. Single-file landing page (`index.html`, styles inline) + `docs/docs.css`. Verbatim copies kept in `sources/maskin.io/`. |
| `github.com/sindre-ai/maskin` (branch `main`, `apps/web/src`) | **The product surface inventory.** App is React + TanStack Router + Tailwind 4 + shadcn/ui (Radix primitives) + lucide-react. Used to enumerate components and screens, not for visual values. |
| This project's prototypes (`Maskin App.dc.html`, `Maskin iOS.dc.html`, `Maskin Knowledge v3.dc.html`, `Maskin Concepts.dc.html`) | Interaction patterns and screen inventory for the human-in-the-loop work. |

Assets in `assets/` are copied from maskin.io: `logo-mark.svg` (the source SVG), `icon-512.png`,
`apple-touch-icon.png`, `favicon.ico`, `og-image.svg/.png`.

**Note on the two palettes.** The maskin.io site and the shipped app currently disagree: the site
is warm (ink `#111110` on paper `#FAFAF8`, blue `#2563EB`), the app ships shadcn's cool zinc
neutrals with an indigo accent. **The site palette is the brand and is what this system encodes.**
Product recreations built here re-skin the app in the warm palette.

## Content fundamentals

**Voice: a blunt operator, not a vendor.** Short declaratives. Contrast sentences that name the
lazy answer and then correct it — "Those share prompts. Maskin shares state." Sentence case
everywhere except uppercase micro-labels. Second person for the reader ("your team", "your key,
your spend"), first person only in the founder note.

- **Claims are concrete and checkable.** "One `docker-compose` file." "$20/seat/month."
  "14-day trial, no credit card." Never "seamless", "revolutionary", "10x".
- **Answer the sceptic in the sceptic's words.** FAQ questions are written as objections, not
  features: "What happens when an agent does something wrong?", "Will this actually improve
  business outcomes, or just make the team feel busier?" Then answer plainly, including the
  limits: "Whether it improves outcomes depends on whether you're running it on the right workflows."
- **Domain nouns are load-bearing and always capitalised as objects:** Insight, Bet, Task,
  Knowledge, Loop, Trigger, Agent, Session, Workspace. A Bet is "a scoped hypothesis with a
  goal, evidence, and a timeline" — borrowed from Shape Up. Use the vocabulary, don't paraphrase it.
- **Agent copy is third-person and attributed:** "Quill asks — Customer-facing dunning copy
  changes", "Analyst clustered 14 signals". Never let an agent speak as "I".
- **Human-in-the-loop language is a promise, not a feature bullet:** "Nothing deploys without a
  human in the loop." "The audit trail stays."
- **Micro-labels are uppercase, tracked `.10em`, and describe a stage or kind:** HOW IT WORKS,
  WORKSPACES, NEW, COMING SOON.
- **Mono for anything machine-shaped:** ids, statuses, object types, commands, cron strings, counts.
- **No emoji.** Anywhere. Arrows (→), em dashes, and the italic serif carry all the emphasis.
- **Italic serif is the only flourish**, reserved for one-line convictions:
  "A chat history is not a team memory."

## Visual foundations

**The idea:** warm printed paper for the human side, mono type for the machine side, one blue
that only ever marks *what is live or what to click*. Nothing decorative.

- **Colour.** Foreground is a warm near-black `--ink #111110` with two quieter steps
  (`--ink-2 #5A5751` body, `--ink-3 #9B958F` meta). Background is off-white `--surface #FAFAF8`
  with a linen band `--linen #F0EDE7` for sunken/alternating sections and a warm hairline
  `--rule #E2DDD7`. One accent, `--accent #2563EB`, used for eyebrows, links, the active node
  in a diagram, checkmarks, and small badges — never as a large fill and never as a gradient
  background. Object types get their own four hues used only as 10%-tint mono tags
  (insight `#5B8DD9`, bet `#E67E22`, task `#27AE60`, knowledge `#7C3AED`). Dark mode is a full
  token swap (`#141412` / `#1C1B18` / `#ECEAE4`, accent lightens to `#3B74F2`), driven by
  `prefers-color-scheme` with a `[data-theme]` override — always support both.
- **Type.** Three families, no exceptions. **Schibsted Grotesk** does everything (400–700);
  **Newsreader italic** appears only as a pull-quote; **JetBrains Mono** (400/500) marks machine
  data. Display sizes are fluid `clamp()` steps (`--step-0`…`--step-4`); UI sizes are a fixed rem
  set (0.62 / 0.68 / 0.75 / 0.8125 / 0.875 / 0.9375rem). Headlines are 700 with negative tracking
  (`-.03em`) and line-height 1.04–1.15; prose runs 1.6–1.65 in `--ink-2` at a 44–52ch measure.
  Uppercase labels are 700 at 0.68rem with `.10em` tracking.
- **Layout.** 1280px container, fluid inline padding `--gap`, fluid vertical rhythm
  `--section-py: clamp(4rem,9vw,8rem)`. Sections alternate paper → linen, with exactly one
  inverted `--ink` section (the manifesto) per page. Grids are plain equal columns
  (3-up cards, 4-up steps, 2-up FAQ) collapsing at 960px then 600px. Fixed 56px nav that is
  transparent until scroll, then `rgba(250,250,248,.92)` + `blur(14px)` + hairline.
- **Cards.** `1.5px` solid `--rule`, radius 12px, `--surface` background, padding 1.25–1.5rem,
  content as a flex column with `.75rem` gaps. Hover: border → `--ink-2`, `translateY(-2px)`,
  `0 4px 16px rgba(17,17,16,.07)`. A card can carry a `3px` coloured top border to signal its
  category — that is the only place colour touches a container edge. Featured cards get an
  `--ink` border and a deeper shadow instead of a tint.
- **Borders & elevation.** `1.5px` is the signature weight (buttons, cards, inputs, panels);
  `1px` for internal table/list rules. Shadows are warm-black at 5–12% opacity and always
  vertical-only; the single coloured shadow is `0 4px 24px rgba(37,99,235,.12)` on an active
  diagram node. No inner shadows. No glows except the hero's 9%-opacity radial accent wash.
- **Radii.** 4px inline code, 5px mono object-type tags, 6px small buttons and object chips,
  8px buttons/icon tiles/toggles, 10px inline banners and card badges, 12px cards and tables,
  14px prompt bar and video frame, 20px chips and agent pills, 999px only for the prompt-bar
  chips and file pills.
- **Pills & chips.** Two flavours: quiet (`--linen` fill, `1px --rule` border, `--ink-2` text) and
  accent (`--accent-dim` fill, `--accent` text). Both sit at `--r-chip: 20px` — a soft capsule, not
  a true pill; only the prompt-bar chips go fully round. Mono chips for object types use a 10% tint
  of their own hue at `--r-tag: 5px` with no border. Integration chips use a **dashed** border to
  read as "connect this".
- **Buttons.** Primary = `--ink` fill, `--surface` text, `1.5px --ink` border, radius 8px, 600,
  `.75rem 1.5rem`. Secondary = transparent with `1.5px --rule`, 500. Ghost = `--ink-2` text only.
  Nav sign-up is the one small `--accent` fill on the site, radius 6px.
- **Motion.** Fast and small. `150ms` on colour/border, `200ms` on shadow + transform,
  `250ms` on nav/panel state. The universal hover is `translateY(-1px)` (`-2px` on cards); the
  only springy easing is `cubic-bezier(.16,1,.3,1)` on submit affordances. Scroll reveals are a
  20px rise over 550ms staggered 80ms. "An agent is working" is a pulsing 8px dot
  (`1.2s ease-in-out infinite`), plus a blinking accent caret for streaming text. Everything is
  disabled under `prefers-reduced-motion`.
- **Transparency & blur.** Only two uses: the scrolled nav, and overlay controls on dark video
  (`rgba(17,17,16,.55)` + `blur(6px)`). Never blurred cards.
- **Imagery.** No photography and no illustration. The visual interest is structural: a
  four-node loop diagram with dashed `--rule` paths that light up in `--accent`, spec tables of
  mono values, and a product video in a 16:9 `--ink` frame. When a real image is required, drop a
  striped placeholder with a mono caption naming what belongs there — do not invent artwork.
- **Diagram language.** Dashed 1.5px paths for latent connections, solid accent for the live one;
  small dark pills (`--ink` fill, 20px radius) label the agent acting on a step; a mono status
  line sits under the diagram.
- **Empty and loading states** use the same linen-and-hairline vocabulary — never spinners on
  large areas; skeleton blocks in `--linen`.

## Iconography

- **Product app:** `lucide-react`. Keep it — 16px in dense UI, 20px in headers, `stroke-width:2`,
  `currentColor`, round caps.
- **Landing page:** hand-inlined SVGs in the same idiom (24px viewBox, `stroke-width:1.5–2`,
  round caps/joins, no fills). Visually consistent with Lucide.
- **Recommendation for new surfaces:** load Lucide from CDN (`lucide@latest`) and set
  `stroke-width:2`, `stroke-linecap:round`. Do not hand-draw icons; do not mix icon sets.
- **Icon containers:** 32–34px square, `--linen` or `--surface` fill, `1px --rule` border,
  radius 8px. Glyph in `--accent` when the tile marks a guarantee (trust bar), `--ink-2` when it
  is a step number or neutral affordance.
- **Unicode as icons** is idiomatic and used deliberately: `→` for progression and links,
  `—` for "before" list bullets, `✓` for feature ticks (in `--accent`), `⌄` for menu chevrons,
  `×` for dismiss, `⚙` for settings, `ⓘ` for summaries. **No emoji, ever.**
- **Logo.** A single open stroke drawn as an M — `M17 60 L17 20 L40 46 L63 20 L63 60` on an 80×80
  `--ink` tile with 14px radius, stroke `--surface`, square caps, **mitre joins** (not round).
  Stroke weight is 6 at favicon size, 10 at nav size. In dark mode the tile becomes `#1C1B18` and
  the stroke `#ECEAE4`. Wordmark is "Maskin" in Schibsted Grotesk 700 at `-.02em`. The name is
  Norwegian for *machine* — the site prints that definition in italic in the footer. Never
  redraw, restretch, or recolour the mark beyond these two themes.

## Component inventory

Enumerated from `apps/web/src/components/` (product) and the landing page's CSS blocks (marketing).
Status below is the build plan for this system; nothing is invented that the sources don't define.

### Foundations — done
`styles.css` → `tokens/{fonts,colors,typography,spacing,shape,motion}.css`, plus 16 specimen cards
in `guidelines/`.

### To build — `components/core/` (from `components/ui/`, shadcn-based)
Button, ButtonGroup, Input, Textarea, Label, Select, Checkbox, RadioGroup, Switch, Badge, Card,
Separator, Tabs, Table, Tooltip, Popover, DropdownMenu, Dialog, Sheet, Breadcrumb, Calendar,
Collapsible, Skeleton, Spinner.

### To build — `components/objects/` (the pipeline primitives)
TypeBadge, StatusBadge, ObjectReference, MetadataBadges, VerifiedChip, LoopCard, BetCard,
LinkedObjects, RelatedObjectsTable, BulkActionBar, PropertySelect, FieldValueInput.

### To build — `components/activity/`
ActivityComment, ActivityItem, ActionBanner, PhaseDivider, DecisionChips, RelationshipNode,
CommentInput, UndoWriteChip, PendingCommentRow, MentionSessionCard, StreamingIndicator.

### To build — `components/agents/`
ActorAvatar, AgentPulse, AgentWorkingBadge, AgentPortraitCard, SessionLogTranscript,
SessionDetailPanel, RunPauseButton.

### To build — `components/shared/`
FilterChip, FilterTabs, IndicatorBadge, UnreadBadge, SourceBadge, EmptyState, LoadingSkeleton,
RelativeTime, AttachedFileCard, UploadProgress, SubscribeToggle, CreatePicker, DateRangePicker,
MarkdownContent, MentionedText, OfflineBanner, FormError.

### To build — `components/navigation/`
Sidebar, SidebarActivity, WorkspaceSwitcher, NavUser, Header, PageHeader, CommandPalette.

### To build — `components/marketing/` (landing page only)
Nav + MobileDrawer, ThemeToggle, PromptBar (+ chips, file pill, route hint), DraftStream,
SectionTag/Title/Sub, TrustBar, SplitBeforeAfter, LoopDiagram, HowCard, MarketplaceCard,
FeatureCard, PricingCard, SpecTable, FAQItem, Manifesto, DemoFrame, Footer.

### To build — UI kits
1. `ui_kits/app/` — Objects list, Object detail (timeline + properties), Loops, Trigger detail, For you.
2. `ui_kits/marketing/` — the maskin.io landing page.
3. `ui_kits/docs/` — docs shell (top bar + sidebar + prose + code blocks) from `docs.css`.

## Index

| Path | What |
|---|---|
| `styles.css` | Global entry point — `@import`s only. Link this one file. |
| `tokens/` | `fonts` (Google CDN), `colors`, `typography`, `spacing`, `shape`, `motion`. |
| `guidelines/` | 16 foundation specimen cards (Colors, Type, Spacing, Brand, Motion). |
| `assets/` | Logo mark SVG, app icons, favicon, OG image. |
| `sources/maskin.io/` | Verbatim landing page, docs page, and `docs.css` — the styling source of truth. |
| `SKILL.md` | Agent-skill entry point (works in Claude Code too). |
| `github.md` | Repo association + sync log. |

## Intentional additions

None yet. Every token value above is lifted verbatim from `sources/maskin.io/`; nothing has been
rounded to a 4/8px grid.
