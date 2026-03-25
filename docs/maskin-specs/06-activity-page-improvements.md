# Activity Page: Filter Buttons and Descriptive Entries

## Summary
Improve the activity page with category filter buttons and more descriptive, linkable entries.

## Current Behavior
The activity feed shows a virtualized list of events with action, actor, entity type, and timestamp. The entries are compact but not very descriptive. There are no category filters.

## Desired Behavior

### Category filter buttons
- Row of toggle buttons at the top: `all | decision | finding | input | agent | human | error`
- Active filter highlighted with accent border and background
- Clicking a filter shows only events matching that category
- Categories should be derived from event types/actions:
  - `decision` — notifications of type needs_input, bet proposals
  - `finding` — insights created/clustered
  - `input` — agent requests for user input
  - `agent` — agent actions (sessions started, objects updated by agents)
  - `human` — human actions (manual object creation, comments)
  - `error` — failed sessions, errors

### Descriptive entries
- Each entry should include enough context to understand what happened without clicking through
- Examples of improved descriptions:
  - Current: `created · object · 25m ago`
  - Improved: `Insight Processor clustered pistachio trend · 25m ago`
  - Current: `updated · object · 22m ago`
  - Improved: `Bet Strategist proposed bet: Pistachio ice cream website · 22m ago`
- Format: `[Avatar] [Actor name] [action description] [target name as link] · [time]`

### Linkable entries
- Entries that reference an object should be clickable, navigating to the object detail page
- The target object name should be styled as a link (e.g. blue text)
- Entries without a specific target (e.g. "created 7 insights") are not clickable

### Error indicator
- Failed events show a small red "error" badge next to the timestamp

## Key Files to Modify
- `apps/web/src/routes/_authed/$workspaceId/activity.tsx` — add filter state and UI
- `apps/web/src/components/activity/activity-feed.tsx` — update entry rendering
- May need to enrich event data or format display strings based on event action + entity type

## Data Requirements
- Events already have `action`, `entityType`, `entityId`, `data`, `createdAt`, and actor info
- Need to categorize events into the filter groups — this could be done client-side based on action/entityType combinations
- For descriptive text, may need to include the entity title in the event data (or join with objects)

## Notes
- The virtualized list should be preserved for performance — filters just change what's rendered
- Consider persisting the selected filter in URL search params so it survives navigation
