# Objects Page: Group by Bets

## Summary
Add an "All" tab to the objects page that groups objects under their parent bet using relationships, giving users a quick overview of which tasks and insights belong to which bets.

## Current Behavior
The objects page shows a flat list of all objects (insights, bets, tasks) with filters for type, status, owner, and search. There is no hierarchical grouping.

## Desired Behavior

### "All" tab (new default)
- Show bets as top-level rows
- Nest related objects (tasks, insights) under each bet using existing relationships (`breaks_into`, `informs`, etc.)
- Indent child rows with a visual indicator (e.g. `↳` prefix)
- Show an "Unlinked" section at the bottom for objects with no bet relationship

### Existing tabs (Insights, Bets, Tasks)
- Group objects by status with section headers (e.g. "active (3)", "proposed (2)")
- Each section shows a count

### Search
- In the "All" tab, search should match both bet titles and their children — if a child matches, show it under its parent bet
- In typed tabs, search filters within the grouped list

## Key Files to Modify
- `apps/web/src/routes/_authed/$workspaceId/objects.tsx` — add tab state and "All" tab logic
- `apps/web/src/components/objects/` — object list components, add nested row rendering
- May need a new query or extend `list_objects` to include relationship data for grouping

## Data Requirements
- Need to fetch relationships alongside objects to build the hierarchy
- Relationships of type `breaks_into` and `informs` define the parent-child structure
- An object is "unlinked" if it has no relationship to any bet

## Notes
- The grouping is purely a frontend presentation concern — no schema changes needed
- Consider caching/memoizing the grouping computation since it involves cross-referencing objects and relationships
