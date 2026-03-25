# Object Detail: Improved Activity Feed with Comments

## Summary
Redesign the activity section on the object detail page to be more readable, and add the ability for users to comment and tag agents or other actors.

## Current Behavior
The object detail page shows an event log (compact list of events like "created", "updated", "status changed"). There is no way for users to leave comments or interact with agents from the object detail page.

## Desired Behavior

### Activity feed
- System events (created, updated, status changed, relationship added) shown as compact single-line entries with an icon, description, and timestamp
- Event icons by type: `◉` created, `✎` updated, `↻` status changed, `⊞` relationship added
- Agent and human messages shown as richer entries with avatar, name, timestamp, and message text
- Threaded replies: messages can have replies, collapsed by default with a "▸ 2 replies" toggle

### Comment input
- Single-line input at the top of the activity section: `[avatar] [input: "Comment or instruct an agent..."] [Send]`
- Users can type a comment that gets added to the activity
- Users can @mention agents or other actors — this should notify/instruct the mentioned agent
- When an agent is @mentioned, the comment becomes an instruction that could trigger a session

### Tagging
- `@` triggers an autocomplete dropdown listing agents and human actors in the workspace
- Selected actor shown as a styled chip in the input
- When submitted with an agent tagged, the system could:
  1. Create a notification for that agent
  2. Or create a session with the comment as the action prompt and the object as context

## Key Files to Modify
- `apps/web/src/routes/_authed/$workspaceId/objects/$objectId.tsx` — activity section
- New component: `ObjectActivity` with comment input + event list
- `apps/web/src/hooks/` — hook for posting comments (may need a new endpoint or use events/notifications)
- `apps/dev/src/routes/` — may need an endpoint for comments, or extend events to support user-authored entries

## Backend Considerations
- Comments could be stored as events with a new action type (e.g. `commented`) and the comment text in `data`
- Or comments could be a new entity linked to objects
- @mentioning an agent needs to trigger something — either a notification or a session creation
- The object ID should be passed as context when creating agent sessions from comments

## Notes
- This is one of the more impactful changes — it turns object detail pages into collaboration spaces between humans and agents
- The threaded replies in the prototype were between agents and humans, showing back-and-forth conversation on a specific object
