repo: sindre-ai/maskin
branch: main
path: apps/web/src

secondary repo: vaerksted-ai/maskin.io (branch main) — landing page + docs; the brand's visual source of truth for the design system

## Last sync
date: 2026-08-03T09:31:00Z
branch: main

### Updated in this project
- Started extracting a **design system** from vaerksted-ai/maskin.io: `styles.css` + `tokens/*` (colors, typography, spacing, shape, motion) lifted verbatim from `index.html`'s inline token block and `docs/docs.css`; 16 foundation cards in `guidelines/`; brand assets in `assets/`; verbatim sources kept in `sources/maskin.io/`; `readme.md` + `SKILL.md`. Component inventory enumerated from `sindre-ai/maskin@apps/web/src/components/` — see readme.md "Component inventory".

### Previously
- Added the missing detail page for triggers that aren't tied to a loop (Loops ▸ "Not tied to a loop" rows are now links) — rebuilt from routes/_authed/$workspaceId/triggers/$triggerId.tsx + components/triggers/trigger-form.tsx: name, Trigger type (Event / Schedule / Reminder + its description), cron schedule builder (frequency chips, day/hour/minute selects), reminder date+time, event When-this-happens (object type · action), status transition, additional conditions with remove/add, "Do this" action prompt with auto-save "✓ Saved", "Using this agent", the ⓘ trigger summary sentence, Enabled/Disabled pill + Enable/Disable, and trash delete.
- For you card now fills the frame (no background scrolling) and carries the object-timeline unread divider ("N new messages · Mark read"); the thread opens at the divider.
- Loops filter: "Running" chip removed, "Waiting on you" renamed "Needs you".

### Previously
- Objects bulk bar rebuilt to the repo's BulkActionBar: count pill + "selected", divider, Status and Driver pickers, copy-link / copy-title icon actions, destructive Archive, ✕ clear (Esc) — read from components/objects/bulk-action-bar.tsx.
- Added the missing human-in-the-loop bulk action on top of that bar: "Answer N asks" opens a sheet listing each selected object's ask with Approve / Hold per row and Approve all.
- Objects list rows waiting on you now preview the ask itself ("Quill asks — Customer-facing dunning copy changes"), sourced from the loop's asks[].
- Objects nav = type sub-pages (All / Bets / Insights / Docs / Customers); one filter chip row below driven by Display ▸ Filter by (Status / Attention / Loop / Driver), with removable pills for the rest.
- Display gained real GROUP BY / ORDER BY lists and a SHOW IN LIST column set (no more blind cycling).

### Previously
- Loops now render the real trigger primitive: name, type (event/cron/reminder), config (entity_type · action · to_status), conditions[], skill, action_prompt, target agent, enabled — read from packages/shared/src/schemas/triggers.ts and components/triggers/trigger-form.tsx.
- Customer feedback loop rebuilt from the 9 live trigger rows in the Development workspace (via the Maskin MCP), with the real statuses (insight new/processing/clustered/scored/parked/discarded, bet signal→archived, task todo→discarded).
- Object types carry their real workspace statuses; added knowledge + relationship (edge triggers).
- Loop builder (natural-language only) emits schema-shaped trigger rows.

### Previously
- Object detail: needs-you banner with jump-to-ask, unread divider + "N new updates", activity filter (All / Comments / Decisions / Changes), collapsed runs of agent updates, clamped long comments, sticky phase dividers, pinned composer, collapsible long description, expandable evidence.
- Objects list: saved-view tabs (Waiting on you / All / In cycle / Archived), active-filter pills with clear-all, "Waiting on you" row signal that also sorts to the top, real Ordering control.
- Board: drag between columns, one-click advance, WIP limits per column.
- Added "Dunning email sequence" (Billing reliability) as the heavy activity example: 30 timeline nodes, 9 long agent comments, 8 reply threads, 4 phase dividers and one open decision.

### Previously
- Object descriptions use the workspace's long structured format (## sections, label lines, scope/DoD bullets), fully expanded.
- Activity section has the Timeline ↔ Related toggle; Related groups by edge type with the repo's verbs and inverses.
- Every object-reference chip now names the graph connection (informs / part of / blocks / relates to) and leads with the type badge.
- Header "Share" replaced by the repo's ⋯ auxiliary action menu (Copy link/title/content, Subscribe, Archive on bets, Delete) with matching shortcuts.
- Object timeline stress-tested with long agent comments and multi-reply threads; phase dividers and decision chips added.
- Driver chip in the object header and a Properties right drawer (core fields, custom fields, files).

## Screen map
| Screen | Built from |
|---|---|
| Object detail — description | components/objects/object-document.tsx |
| Object detail — Activity toggle | components/activity/object-activity.tsx |
| Object detail — Related view | components/activity/relationships-table.tsx, components/objects/related-objects-table.tsx, components/objects/linked-objects.tsx |
| Timeline relationship + reference chips | components/activity/relationship-node.tsx, components/shared/object-reference.tsx |
| Object detail — ⋯ menu | components/objects/auxiliary-action-menu.tsx |
| Object detail — Properties drawer | components/objects/properties-drawer.tsx, metadata-properties.tsx, object-files.tsx, property-selects.tsx |
| Timeline phases + decision chips | components/activity/build-phases.ts, phase-divider.tsx, decision-chips.tsx |
| Nav / screen inventory | components/layout/sidebar.tsx, routes/_authed/$workspaceId/* |
| Objects list — bulk action bar | components/objects/bulk-action-bar.tsx |
| Loop detail — Built from (types/triggers/agents) | packages/shared/src/schemas/triggers.ts, components/triggers/trigger-form.tsx, components/triggers/slack-filters.tsx |
| Customer feedback loop wiring | live Development workspace triggers (MCP list_triggers), apps/dev/src/lib/dev-bootstrap.ts, apps/dev/src/lib/integrations/providers/slack/default-triggers.ts |
| New loop (natural language) | createTriggerSchema shape in packages/shared/src/schemas/triggers.ts |
| Trigger detail (not tied to a loop) | routes/_authed/$workspaceId/triggers/$triggerId.tsx, routes/_authed/$workspaceId/triggers/index.tsx, components/triggers/trigger-form.tsx, hooks/use-triggers.ts |
