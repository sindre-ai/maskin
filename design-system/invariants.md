# Protected design rules (web app)

These are the things in `apps/web` that an AI-made design change must not override. They change only when a person changes the rule on purpose.

Scope is the web app only. The first 20 rules are below.

## How this file works

- A rule goes in only if it names its check. No check, no rule.
- A check is one of: an existing end-to-end spec (named), a screenshot check (screen, light and dark, 375/768/1024 wide), or a lint rule.
- Status is **live** when the check exists and runs in CI today, or **gap** when the rule is true today but nothing yet fails if it breaks. Every gap has its own follow-up task, linked in the table at the bottom.
- If a change makes a check fail, fix the change. Do not edit the check or the rule to make the change pass.
- Changing, loosening or deleting a rule, or its check, is a human-review PR. This file is listed in `.maskin/protected-paths.yml`, so the risk check scores any edit to it 100 (HUMAN REVIEW REQUIRED).
- Rules are numbered in two groups. **PF** is a product feature that must keep working. **DP** is a design pattern that must not drift. IDs are never reused.

Related: `.claude/rules/frontend.md` (how to build), `design-system/README.md` and `design-system/patterns/` (what the patterns are). This file is what is protected, and how it is checked.

Specs are in `apps/e2e/src/tests/`. Viewports are the ship-gate three from `apps/e2e/src/helpers/viewports.ts`: 375, 768 and 1024.

## Product features that must keep working

### PF-01 One filled button on a decision card
- **Rule:** A For You decision card shows the recommended option as one full-width filled bar, the other options as a quiet row beneath it, and what the agent expects as one line of small print.
- **Why:** The person decides in seconds. Two filled buttons make them stop and compare.
- **Check:** `foryou-decision-bar.spec.ts`, test "one bar, quiet alternates, one line of reasons" at 375, 768 and 1024. Also "the bar reads in light mode" and "dark mode".
- **Status:** live

### PF-02 Choosing the bar answers the whole card
- **Rule:** Choosing the bar sends the option label as the reply and shows the decision receipt.
- **Why:** The reply is what the agent acts on. A card that looks answered but sent nothing stalls the work.
- **Check:** `foryou-decision-bar.spec.ts`, test "choosing the bar answers the whole card".
- **Status:** live

### PF-03 The chat composer never sends a secret
- **Rule:** A message that contains a provider key is stopped in the composer. The key is never rendered, never stored in the message, and never written to local or session storage. The server refuses a raw key posted directly.
- **Why:** A key in a transcript is a leaked key.
- **Check:** `keychain-chat-capture.spec.ts`, tests "vault shows Resuming, then Live once the new session speaks" (3 viewports), "undo ends the session" and "the server refuses a raw key posted straight to the conversation (backstop)".
- **Status:** live

### PF-04 A bet shows its real status
- **Rule:** The bet header shows the raw status the team set, never a derived chip. The Objects list row shows the status indicator for a bet.
- **Why:** People steer bets by status. A derived chip in its place shows a state nobody set.
- **Check:** `bet-status-indicator.spec.ts`, tests "header shows the raw status and never the derived chip states" and "objects overview row shows the indicator for a bet" (3 viewports).
- **Status:** live

### PF-05 Viewers see write controls disabled, not hidden
- **Rule:** For a viewer, every write control (status and driver pickers, New, comment box, decision buttons, bulk actions, archive, delete) is disabled with an explanation. Copy and clear stay available. For a member nothing changes.
- **Why:** A button that is hidden is a missing feature. A button that is live and then errors is a bug people report.
- **Check:** `apps/web/src/__tests__/components/viewer-read-only.test.tsx` and `viewer-read-only-settings.test.tsx` (component tests, live). No end-to-end check at the three widths yet.
- **Status:** gap (end-to-end check at 375, 768 and 1024)

### PF-06 Agent initials are two letters and skip punctuation
- **Rule:** The avatar shows two initials, with punctuation skipped. "Linker (Sigrid)" shows LS.
- **Why:** A broken avatar (for example "L(") is small, visible on every message, and has shipped before.
- **Check:** `actor-avatar-initials.spec.ts`, tests "renders initials in the comment-author avatar slot" and "renders LS for "Linker (Sigrid)"" at 375, 768 and 1024.
- **Status:** live

### PF-07 Loading, failed fetches and offline look the same everywhere
- **Rule:** A page-size load shows skeleton blocks, not a spinner. A failed fetch shows inline muted text naming what did not load. Losing the network shows the offline banner.
- **Why:** One vocabulary for waiting and failing, so people learn it once.
- **Check:** `states-vocabulary.spec.ts`, tests "offline banner appears when navigator.onLine flips to false", "loading skeleton (not a spinner) is shown while agents list is fetching" and "inline error UI appears when the marketplace fetch fails".
- **Status:** live

### PF-08 The header New menu keeps every entry point
- **Rule:** The header New menu offers New chat, New task, New loop, New agent and Find a past conversation, at every width and on an object page. Page-level actions live in the page header.
- **Why:** It is the one place people start things. Actions placed elsewhere become lone buttons nobody finds.
- **Check:** `header-new-menu.spec.ts`, tests "renders all entry points" (3 viewports) and "keeps "Create an object" and the rest of the menu on an object-detail page".
- **Status:** live

### PF-09 Opening a description never rewrites it
- **Rule:** Opening a description and leaving it without an edit sends nothing. A description the editor cannot round-trip opens read-only. A save that would drop content is refused.
- **Why:** Descriptions hold agent-written markdown. A silent rewrite on blur destroys it.
- **Check:** `object-description-safe-save.spec.ts`, tests "opening and blurring with no edit sends nothing and leaves the body unchanged", "a description with ... opens read-only and sends nothing" and "a rewrite that would drop a link title is refused and the stored text stays".
- **Status:** live

### PF-10 Enter in the chat composer follows the device
- **Rule:** Below 768 wide, Enter inserts a newline. At 768 and wider, Enter sends.
- **Why:** A phone keyboard has no Shift. Sending on Enter there sends half-written messages.
- **Check:** `chat-mobile-enter.spec.ts`, tests "Enter inserts a newline" at 375 and "Enter sends" at 768 and 1024.
- **Status:** live

## Design patterns that must not drift

### DP-01 Reveal-once
- **Rule:** A secret the product will not show again appears in a dialog that Escape, the scrim and a corner close cannot dismiss. Only the primary button closes it. Afterwards the value is masked.
- **Why:** Losing the value by accident is the failure the pattern prevents. See `design-system/patterns/reveal-once.md`.
- **Check:** `extensions-webhook.spec.ts`, test "adds an extension, reveals the URL and secret once, and shows a committed delivery" at 375, 768 and 1024.
- **Status:** live

### DP-02 Two fonts, self-hosted, numbers aligned
- **Rule:** Text is Schibsted Grotesk, code and numbers are JetBrains Mono, both served from `/fonts/` with no CDN. Anything in `font-mono` uses tabular numbers, including the unread count.
- **Why:** A third font or a CDN call changes the look and layout shift. Moving digits make counters jitter.
- **Check:** `typography.spec.ts`, tests "fonts are self-hosted, no Google Fonts CDN, only Schibsted Grotesk + JetBrains Mono preloaded", "elements with font-mono class have tabular-nums applied", "unread badge count uses tabular-nums" and "cumulative layout shift stays under 0.05 on cold cache".
- **Status:** live

### DP-03 Reduced motion turns motion off
- **Rule:** With reduced motion on, transitions and animations collapse to under 1 ms on every route. Motion durations come from the named tokens in `app.css`.
- **Why:** Some people get ill from motion. The guard is one global rule, and one overriding class can break it.
- **Check:** `motion-reduced-motion.spec.ts`, one test per route ("<route> - motion collapses under reduce"), plus `apps/web/src/__tests__/lib/app-css-motion.test.ts`.
- **Status:** live

### DP-04 Light and dark are both first-class
- **Rule:** Every screen reads correctly in light and dark with the same tokens. Dark is not a later pass.
- **Why:** The theme is a user setting. A screen that only works in one is broken for half the people.
- **Check:** Screenshot check, `visual.spec.ts` (For You and Objects list in light, dark and at 375; object detail in light and dark at 375, 768 and 1024), `typography.spec.ts` (For You, light and dark, at 375, 768 and 1280), `app-shell.spec.ts` "shell surfaces render in light and dark mode at 375px", and `a11y-routes.spec.ts` which runs each route in both themes.
- **Status:** gap (most other screens have no light and dark screenshot check)

### DP-05 No sideways page scroll at the three widths
- **Rule:** No surface produces a horizontal scrollbar on the page at 375, 768 or 1024. Wide content scrolls inside its own box.
- **Why:** Mobile is a first-class target, and an overflowing page breaks touch scrolling.
- **Check:** `mobile-qa.spec.ts`, tests "no horizontal overflow on any surface" (3 viewports) and "walks the bet first-test flow at 375px without horizontal overflow".
- **Status:** live

### DP-06 Touch targets are at least 44 px
- **Rule:** On touch widths a small control keeps a hit area of 44 by 44 px, with the visible glyph unchanged. The bulk-select checkbox and the chat attach button are the guarded cases.
- **Why:** A 16 px box is not a thumb target. Two close rows must not toggle each other.
- **Check:** `ios-bulk-select-tap-area.spec.ts` ("tap 15px off-center on the row-select checkbox toggles selection") and `ios-chat-attach-tap-area.spec.ts` ("44 px ::before hit surface with visible glyph unchanged").
- **Status:** live

### DP-07 Keyboard reach and a visible focus ring
- **Rule:** The top-level nav is reachable with Tab and shows a visible focus ring. Cmd or Ctrl+K opens the command palette, Escape closes it, and Tab cannot leave it while it is open.
- **Why:** Keyboard use is a core path in the app, and an invisible focus ring locks people out.
- **Check:** `a11y-keyboard-paths.spec.ts`, tests "the top-level nav is tab-reachable and reports a visible focus ring", "the command palette opens with Cmd/Ctrl+K and closes with Escape" and "opening the palette does not let Tab escape back into the page".
- **Status:** live

### DP-08 Solid surfaces, no blur
- **Rule:** Overlays, sheets, menus and cards are solid and lifted by shadow. No frosted or translucent surface: no `backdrop-blur`, `backdrop-filter` or `backdrop-saturate` in `apps/web/src`.
- **Why:** Solid zinc with indigo is the v2 look. Frosted surfaces are the first thing a redesign tends to bring back.
- **Check:** Lint rule: a CI script that fails on those three strings in `apps/web/src` outside tests. Zero matches today, so it passes on day one.
- **Status:** gap (script not written)

### DP-09 Colour comes from tokens
- **Rule:** Colours are semantic tokens (`bg-card`, `text-muted-foreground`, `bg-brand`). No hex, rgb or oklch value in a class, a style prop or a component.
- **Why:** Tokens are how light and dark stay in step and how a palette change lands in one place.
- **Check:** Lint rule: a CI script that fails on a new hex colour in `apps/web/src` outside comments and tests. It starts as a ratchet: the 3 files that carry one today are `components/objects/detail-meta-row.tsx`, `components/objects/list/list-row.tsx` and `components/objects/linked-objects.tsx`. A new one fails.
- **Status:** gap (script not written)

### DP-10 Object detail is one document shell
- **Rule:** An object opens as a document: a hero row above a static `h1` title at weight 600 or heavier, and no legacy properties rail.
- **Why:** Every object type uses the same page. A one-off layout per type is how the app drifted before v2.
- **Check:** `object-detail-header.spec.ts` ("renders hero above static <h1>"), `object-detail-sidebar.spec.ts` ("shell renders with no properties-sidebar chrome") at 375, 768 and 1024, and `typography.spec.ts` ("object title renders at a bold weight").
- **Status:** live

## Gaps and their follow-up tasks

| Rule | Gap | Follow-up task |
|------|-----|----------------|
| PF-05 | Viewer read-only has component tests only | https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/baeb5cc6-98be-4222-a92d-ef0daef6cd04 |
| DP-04 | Light and dark screenshots cover few screens | https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d0b9c3d0-8592-4fc2-ae73-5886f4be4a07 |
| DP-08 | No lint script for blur | https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/365cf3e5-2476-4cd9-8d6e-320bc1ab9bf2 |
| DP-09 | No lint script for raw colours | https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/30c10c07-394c-4e32-9522-8358826e7eec |
