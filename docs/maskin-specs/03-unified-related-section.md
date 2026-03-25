# Object Detail: Unified Related Section

## Summary
Consolidate the current three separate related sections (Linked Insights, Tasks, Related) into a single "Related" section with filter buttons by type.

## Current Behavior
The object detail page has three distinct sections for related objects:
- Linked Insights (informs relationship)
- Tasks (breaks_into relationship)
- Related (other relationship types)

Each has its own heading and layout.

## Desired Behavior

### Single "Related (N)" section
- One section header showing total count: `Related (8)`
- Filter buttons when multiple types exist: `All 8 | insights 2 | tasks 5 | bets 1`
- Active filter highlighted with accent color
- A `+ link` button aligned to the right of the header to add new relationships

### Each related row shows:
- Object title
- Relationship type label (e.g. `informs`, `breaks_into`, `blocks`)
- Status badge
- Object type label
- Agent working spinner (if applicable, ties into spec 02)
- Clicking navigates to that object's detail page

## Key Files to Modify
- `apps/web/src/routes/_authed/$workspaceId/objects/$objectId.tsx` — object detail page, replace three sections with one
- `apps/web/src/components/objects/` — may need a new `RelatedSection` component
- Reuse existing relationship fetching hooks

## Notes
- No backend changes needed — same relationship data, just presented differently
- The filter buttons should only appear when there are 2+ different types in the related list
- The relationship type label on each row gives users context they'd lose by merging the sections
