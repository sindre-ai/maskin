# Slack setup UX — channel picker, auto-join, failure copy, confirmation, membership indicator

**Bet:** [c31e6d74 — Slack setup UX](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/c31e6d74-a413-4b67-9278-a070f143d16d)
**Prototype:** `prototypes/c31e6d74-slack-setup-ux/index.html`
**Design PR:** (see cover-letter comment on the bet)

## User + job
A Maskin user wiring a new trigger to a Slack channel wants to (a) pick the channel by name — never by ID, (b) know instantly when a private-channel invite is missing, (c) trust that Maskin is actually in the channel and will stay in the channel. Success = ≤3 steps from "create trigger" to "confirmation-in-channel", zero raw IDs, zero silent failures.

## Design system reuse
**Reuses (unchanged):**
- `Badge` (`components/ui/badge.tsx`) with `variant="secondary"` / `variant="outline"` + status-token classes (`bg-status-active-bg text-status-active-text`, `bg-status-paused-bg text-status-paused-text`, `bg-status-failed-bg text-status-failed-text`) — used as-is for the membership badge, paused pill, and disconnected pill.
- `Button` (`components/ui/button.tsx`) — `default` for Save, `outline` for Copy-invite / Reconnect, `ghost` for tertiary actions. Sizes: `sm` on inline actions, default on the primary Save.
- `Input` (`components/ui/input.tsx`) for the search-in-picker and the 1000+ fallback text field.
- `ResponsivePopover` (`components/ui/responsive-popover.tsx`) as the picker panel container — same primitive `SearchableMultiSelect` uses, so mobile automatically becomes a bottom sheet with no extra work.
- `SearchableMultiSelect` (`components/triggers/searchable-multi-select.tsx`) — reused verbatim for the pre-existing include/exclude filter multi-selects further down the form. Not modified.
- `PageHeader` shape from `routes/_authed/$workspaceId/triggers/$triggerId.tsx` — the header row with autosave chip + dropdown menu is untouched; we only slot the new workspace-membership badge into the sidebar column on the detail page.
- Existing paused-trigger menu action (`Pause/Resume trigger` in the header dropdown) — the auto-pause on kick reuses this exact mutation path; no new pause plumbing.
- Tokens: `--brand-subtle` / `--brand-subtle-foreground` for the channel chip, `--muted` / `--border` for the inline banner background, `--st-active-*` / `--st-failed-*` / `--st-paused-*` for the membership badge, `--success` / `--warning` / `--destructive` for the save-status pill.
- Motion: `--duration-180 var(--ease-standard)` for the save-status pill transitions; `--duration-slide` for the mobile sheet slide-in (inherited from `ResponsivePopover`).

**Extends (one new variant each, both minor):**
- **`SearchableSelect`** — single-select twin of `SearchableMultiSelect`. Same file (`components/triggers/searchable-multi-select.tsx`), same popover/input/list scaffold, differs only in `selectedId: string | null` instead of `selectedIds: string[]` and rendering the selected value in the trigger button rather than as a chip row above it. Rationale: the primary channel wiring is a 1-of-N choice; forcing users through a multi-select and then only reading `[0]` is the kind of drift Product Designer is here to prevent.
- **`Banner` inline pattern** — the existing "Connect Slack to add channel and user filters." block in `slack-filters.tsx` is a rounded muted-bg + border div with a one-line message. This bet needs three semantic variants (warning, danger, info) with an icon, title, body, and action buttons. Formalize the existing div into a shared `<Banner variant="warning|danger|info">` in `components/shared/banner.tsx`. Rationale: same styling shape as `offline-banner.tsx` (already inline in shared/), just parameterized. Reason for standardizing now, not later: this bet ships four bannered states (private-channel fail, bot-kicked, workspace-disconnected, reconnect-nudge) and shipping four ad-hoc divs would guarantee drift.

**New patterns (one, small):**
- **`IntegrationStatusBadge`** — a green/red dot + word pill for "workspace-level" integration health. Green: `Maskin is in this workspace`. Red: `Maskin was removed from {workspace}`. Uses the existing `--st-active-*` / `--st-failed-*` tokens but is a semantically distinct component from `StatusBadge` because it represents integration liveness, not object status (workspace is not a first-class object with a `status` field). Path: `components/shared/integration-status-badge.tsx`. Rationale for a new component vs. calling `<StatusBadge status="active" />` inline: (a) the label copy is verb-y ("Maskin is in this workspace") not a status word, (b) it will be reused verbatim on the Integrations settings page in a follow-up bet, (c) the red state carries a call-to-action (reconnect) which `StatusBadge` doesn't own. **Lands in the design-system doc (`.claude/skills/maskin-design/readme.md`) in the same PR** with a one-line entry under "Integration health" and a link to this SPEC as the rationale.

## Flow
1. User opens **new trigger** → picks Slack event type → **Screen 1** renders with the channel-picker row empty and the save button in `Draft` state.
2. User clicks the picker trigger → panel opens → they either **type-ahead** to find a channel or scroll the list. Private channels show a lock glyph and the hint `private`.
3. User picks `#product-launches` (public) → chip appears in trigger, panel closes.
4. User presses **Save trigger** → **Screen 2**: save-status pill cycles `Saving` (spinner, warning color) → `Joining #product-launches` (spinner, warning color, calls `slack_join_channel` from the preceding bet) → `Saved · Maskin joined #product-launches` (checkmark, success color).
5. Simultaneously, **Screen 3**: Maskin posts the confirmation message to `#product-launches`. User navigates to the channel in Slack, sees the message.
6. Later, user opens the trigger's detail page → **Screen 4**: workspace-membership badge in the sidebar reads `Maskin is in this workspace` (green). Everything is calm.
7. **Failure branch** — if user had picked `#oncall-alerts` (private) at step 3, save call returns `not_in_channel` → Screen 1 renders the warning banner inline above the picker with the verbatim invite copy and a Copy-command button. Save button remains enabled (so the retry after invite is one click). Save-status pill reads `Couldn't join #oncall-alerts` in destructive color.
8. **Kicked branch** — after successful setup, Maskin subscribes to `member_left_channel`. If @Maskin is later removed from `#product-launches`, the trigger auto-pauses and the detail page renders the danger banner across the top plus a red membership pill. If the entire workspace connection is revoked, the workspace-level badge flips red and the same banner nudges reconnection.

## States (per screen)

### Screen 1 — Trigger setup, Slack channel section
| State | What shows | Interaction / transition |
|---|---|---|
| **Default (empty)** | Combo trigger reading `Search channels…` (muted). Field caption below reading the auto-join preamble. | Click trigger → open popover panel with search-in-list + list of channels. |
| **Popover open — populated** | Search input focused, top of list; list items: `#name` (public with hash glyph) or lock-glyph + name (private) + channel-ID hint on the right. | Click item → chip replaces `Search channels…`, panel closes. Esc / click-outside → panel closes with no change. |
| **Popover open — loading** | Search input disabled, list body shows spinner + `Loading channels from Slack…` | Auto-transitions to Populated when `useSlackConversations` resolves. |
| **Popover open — empty (search miss)** | Search input still focused, list body shows `No channels found` + one-line explainer: `Nothing matched your search. Slack channels you can see in your account will appear here.` | User clears the query → returns to Populated. |
| **Popover open — 1000+ channels fallback** | Panel body shows a `Too many channels to browse` header + one-line explainer + a mono text input for raw ID or `#name`. | Paste ID + Enter → same chip render as a picked item. Loading list is skipped. |
| **Selected — public channel** | Trigger shows `#product-launches` chip (brand-subtle background); caret rotates. | Click chip area → reopens picker. |
| **Selected — private channel, before save** | Trigger shows `#oncall-alerts` chip with a lock glyph. | No inline warning yet — validation is deferred to save so users can pick freely. |
| **Save button** | `Save trigger` — enabled once a channel is picked. `Saving…` — disabled during in-flight. | Focus ring uses `--ring`. |
| **Save-status pill (header)** | Sits next to the Save button, next to the breadcrumb. States below. | Transitions between states use `duration-180 ease-standard`. |

### Screen 2 — Save flow, save-status pill states
| State | Copy | Color / icon |
|---|---|---|
| `Draft` | `Draft` | Muted, no icon. |
| `Saving` | `Saving` | Warning, spinner. |
| `Joining` | `Joining #{channelName}` | Warning, spinner. |
| `Saved` (public happy path) | `Saved · Maskin joined #{channelName}` | Success, checkmark. |
| `Saved` (already-a-member) | `Saved` | Success, checkmark. (No "joined" clause — bot was already in the channel.) |
| `Couldn't join` (private) | `Couldn't join #{channelName}` | Destructive, X icon. Warning banner renders inline above the picker (see Failure copy). |
| `Save failed` (generic Slack API error) | `Save failed — try again` | Destructive, X icon. Neutral inline banner with the raw Slack error code appears above the picker. |

### Screen 3 — Confirmation-in-channel (rendered as it appears in Slack)
- **When posted:** exactly once, immediately after a successful save (Saved state reached), from the Maskin app bot user.
- **Layout:** Slack app message with an inline attachment card. Message text names the trigger; attachment reiterates the trigger name, the event type, and who configured it, plus two action buttons: `View trigger` (deep-link to Maskin trigger detail), `Pause` (calls the existing pause mutation).
- **Not posted:** on trigger *edit*; on retry after private-channel failure (only on the first successful save); on reconnect (a distinct copy — see below).

### Screen 4 — Trigger detail page
| State | What renders |
|---|---|
| **Default (healthy)** | Header shows `Saved` chip + on/off Switch (green when enabled). Sidebar workspace card shows green `Maskin is in this workspace` pill + workspace metadata. Channel card shows `#name` + channel ID + join date. |
| **Trigger paused by user** | Header replaces `Saved` chip with a `Paused` pill (muted). On/off Switch reads `Off`. Sidebar workspace pill still green. No banner. |
| **Trigger auto-paused because @Maskin was kicked from *this* channel** | Danger banner across top with verbatim copy (see Failure copy). Header shows `Paused` pill. Switch reads `Off`. Sidebar workspace pill still green (workspace connection intact); channel card shows a small `Bot not in channel` sub-line. |
| **Whole Slack workspace disconnected** | Danger banner across top: `Maskin was removed from Acme HQ — reconnect the integration`. All Slack triggers on this workspace show the same banner + auto-paused pill. Sidebar workspace pill flips red: `Maskin was removed from {workspace}`. |

## Responsive
- **Mobile (≤640px):** Sidebar collapses to a top hamburger (existing pattern, out-of-scope for this bet). Header title stacks above the save-status pill; Save button drops to a full-width sticky bar at the bottom. Picker popover becomes a bottom sheet automatically via `ResponsivePopover` (existing behavior). Banner icons + title stack on top of body text; action buttons wrap.
- **Tablet (641–1024px):** Same as desktop for Screen 1 & 2. Screen 4 detail-grid collapses from two columns to one — trigger card first, workspace card second (the workspace card is important context but not primary).
- **Desktop (>1024px):** Two-column detail-grid; picker popover anchored under the trigger, `width: 100%` of the row (which is capped by the card width — around 480–560px in typical layouts).

## Copy — verbatim (all user-visible strings)

### Picker
- Trigger placeholder: `Search channels…`
- Field label: `Fire in this channel`
- Field caption: `Maskin will auto-join public channels on save. Private channels need /invite @Maskin first.`
- Popover search placeholder: `Search channels…`
- Loading: `Loading channels from Slack…`
- Empty state title: `No channels found`
- Empty state body: `Nothing matched your search. Slack channels you can see in your account will appear here.`
- **1000+ fallback title:** `Too many channels to browse`
- **1000+ fallback body:** `This workspace has more than 1,000 channels. Paste a channel ID or #name below and press Enter.`
- 1000+ fallback input placeholder: `#product-launches or C0456EFGH`

### Save-status pill (header)
- Idle: `Draft`
- Saving: `Saving`
- Joining: `Joining #{channelName}`
- Saved (joined): `Saved · Maskin joined #{channelName}`
- Saved (already member): `Saved`
- Couldn't join: `Couldn't join #{channelName}`
- Generic error: `Save failed — try again`

### Failure banners
- **Private-channel save failure — title:** `Invite @Maskin to #{channelName} first, then save again`
- **Private-channel save failure — body:** `Slack doesn't let bots auto-join private channels. Run the invite command in the channel, then come back and press Save.`
- **Private-channel save failure — actions:** button `Copy /invite @Maskin` (copies the literal string `/invite @Maskin` to clipboard, shows `Copied ✓` for 1400ms on success); button `Open #{channelName} in Slack ↗` (opens `slack://channel?team={teamId}&id={channelId}` with an https fallback).
- **Bot-kicked from a wired channel — title:** `@Maskin was removed from #{channelName} — reinvite or reconnect the trigger`
- **Bot-kicked from a wired channel — body:** `This trigger was auto-paused when @Maskin was kicked from the channel on {date}. No events have fired since.`
- **Bot-kicked — actions:** `Reconnect trigger` (primary, calls the existing `slack_join_channel` + resume mutations) + `Copy /invite @Maskin` (outline).
- **Whole workspace disconnected — title:** `Maskin was removed from {workspace} — reconnect the integration`
- **Whole workspace disconnected — body:** `All Slack triggers on this workspace were auto-paused when the integration was revoked. Reconnect the workspace to resume.`
- **Whole workspace disconnected — actions:** `Reconnect Slack workspace` (primary) + `Delete trigger` (ghost).

### Confirmation-in-channel (Slack message)
- **Message text:** `Maskin is now listening here for {trigger name}.`
- **Attachment title:** `{trigger name}`
- **Attachment meta:** `Fires on {entity_type} in this channel · configured by {actor display name}` (entity type rendered in inline code, e.g. `slack.app_mention`).
- **Attachment button 1:** `View trigger` (deep-links to trigger detail).
- **Attachment button 2:** `Pause`.
- **Reconnect variant** (posted after a reconnect, only when the previous state was auto-paused-due-to-kick): `Maskin is listening here again for {trigger name}.`

### Membership badges (workspace-level, sidebar of trigger detail)
- **Green — connected:** `● Maskin is in this workspace`
- **Red — removed:** `● Maskin was removed from #{channelName}` when it's the channel that lost the bot; `● Maskin was removed from {workspaceName}` when it's the whole workspace that revoked the integration.

### aria-labels + non-visible strings
- Picker trigger `aria-label`: `Choose a Slack channel`
- Copy button `aria-label`: `Copy invite command to clipboard`
- Save-status pill `aria-live="polite"` announcement on state change: `{state-copy}` (e.g. "Saving", "Joining product-launches").

## Interaction details
- **Motion:** Save-status pill uses `duration-180 ease-standard` for color/text transitions; the picker popover uses `ResponsivePopover`'s existing motion (fade + slight scale on desktop, `duration-slide` bottom-sheet on mobile). Reduced-motion respects the global `@media (prefers-reduced-motion: reduce)` block in `app.css` — animations become 0.001ms.
- **Keyboard:**
  - Tab order on Screen 1: Trigger name → Channel picker trigger → (Copy invite / Open in Slack, if banner visible) → Optional filters → Save.
  - Picker trigger: `Enter`/`Space` opens the popover, focus lands in the search input.
  - Popover list: `↓`/`↑` moves focus between items, `Enter` selects, `Esc` closes without picking.
  - `Cmd+Enter` on the form triggers Save (existing form convention in `TriggerForm`).
- **Accessibility:**
  - Picker trigger `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`.
  - Popover list `role="listbox"`; items `role="option"` with `aria-selected`.
  - Banner has `role="status"` for the private-channel warning, `role="alert"` for the danger variant (bot kicked / workspace disconnected) so screen readers pick up the change immediately.
  - Save-status pill wrapped in an `aria-live="polite"` region so state transitions are announced without stealing focus.
  - Membership badge `aria-label` reads the full sentence (`Maskin is in this workspace`), not just the color; the color dot is `aria-hidden`.
  - Copy-command button announces success via a visually-updating label (`Copied ✓`) and an SR-only `aria-live` region.
  - Contrast: all copy-on-color combinations use the app's semantic tokens which have been contrast-checked at the token layer.

## Out of scope (deliberately)
- Per-channel red-state indicators for triggers other than the one being viewed. Ship v1 at **workspace-level granularity** (per the bet's Risk flag on PagerDuty).
- Multi-channel wiring management page (defer to v2 — the detail page is designed to grow into it).
- Slash-command entry points (`/maskin subscribe`, etc.) — Architect ADR keeps them off.
- `chat:write.public` fallback (Sentry pattern) — Maskin needs read.
- Auto-created project/incident channels (Linear/PagerDuty) — no Maskin loop parallel.
- Redesign of the include/exclude filter multi-selects further down `SlackFilters` — that's the existing `SearchableMultiSelect`, unchanged.
- Redesign of the Integrations settings page (where the workspace itself is connected/reconnected) — the "Reconnect Slack workspace" button on the detail-page banner links there but this bet doesn't redesign the target page.
- Dark mode — tokens are dark-ready (see `app.css` `.dark` block); the prototype ships light-only. Developer inherits dark automatically.

## Open questions (to Sebk on aesthetic; to Developer on feasibility)

1. **Confirmation-in-channel — attachment card vs. plain text?** The prototype shows a Slack attachment card (`slack-attachment` with a colored left rule + title + meta + two buttons). GitHub's reference message is plainer (single sentence + link). The card gives us `View trigger` / `Pause` inline buttons which are genuinely useful, but it's more chrome. **Sebk's call.** Fallback: ship the plain-text version if the card feels over-engineered; the inline buttons can move to a follow-up post.
2. **1000+ channel fallback threshold.** Researcher's brief cites `1000` as the Slack API practical limit for `conversations.list` before pagination becomes painful. Prototype uses `>1,000` verbatim in the copy. Developer: is the actual threshold in our impl `1000`, `1024`, `2000`? If the number differs, update copy at implementation time — the shape doesn't change.
3. **Reconnect after kick — should the confirmation-in-channel repost?** Prototype spec says yes, with the `Maskin is listening here again for {trigger name}.` variant. Alternative: no repost, silent resume (avoids noise if a user is toggling frequently). Leaning "yes, repost" because the silent-resume path is exactly the kind of thing that leads back to the footgun the bet is fixing.
