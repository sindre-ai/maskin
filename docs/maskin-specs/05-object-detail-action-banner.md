# Object Detail: Action Banner for Pending Decisions

## Summary
When an object has a pending notification that needs user input (e.g. a proposed bet needing acceptance), show a prominent action banner at the top of the object detail page.

## Current Behavior
Notifications that need user action only appear on the Pulse/For You dashboard. If a user navigates directly to an object detail page, they don't see that a decision is needed.

## Desired Behavior

### Action banner
- Shown at the top of the object detail page, above the title
- Styled with a colored border and background to stand out (e.g. amber for decisions)
- Contains:
  - A short description: "This bet needs your decision"
  - Action buttons matching the notification's input type (e.g. "Accept" / "Reject")
- Clicking an action button resolves the notification (same as responding on the Pulse page)
- Banner disappears after the user takes action

### When to show
- When there is a pending notification linked to this object (via `objectId` or entity reference in the notification)
- Only for `needs_input` type notifications, not informational ones

## Key Files to Modify
- `apps/web/src/routes/_authed/$workspaceId/objects/$objectId.tsx` — add banner component at top
- `apps/web/src/components/pulse/notification-input.tsx` — reuse the input rendering logic
- `apps/web/src/hooks/` — query for pending notifications filtered by object ID

## Data Requirements
- Need to query notifications filtered by the current object's ID
- The notification system already supports linking to objects — need to verify the field used (`objectId` or `entityId`)
- If notifications don't currently store object references, may need to add this to the notification schema

## Notes
- This makes action items follow the user to wherever they are, rather than requiring them to check the Pulse page
- Should reuse the existing notification response mutation to keep behavior consistent
- Consider also showing this on the objects list page as a small indicator (e.g. an icon on the row)
