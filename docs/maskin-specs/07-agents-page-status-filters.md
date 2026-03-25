# Agents Page: Status Filters and Richer Cards

## Summary
Add status filter tabs and show more useful information on each agent card — what it does, what it's currently doing, and what it last did.

## Current Behavior
The agents page shows a grid of agent cards with avatar, name, last event action + time, and active/idle status. There are no filters.

## Desired Behavior

### Status filter tabs
- Row of tabs at the top: `All (5) | Working (1) | Idle (3) | Failed (1)`
- Each tab shows a count
- Counts derived from:
  - `working` — agent has a currently running session
  - `idle` — agent has no running session and last session was not failed
  - `failed` — agent's most recent session failed (and no session currently running)

### Richer agent cards
- **Agent name** with status indicator (spinner if working, colored dot otherwise)
- **Status label** aligned right: "working" (accent color), "idle" (muted)
- **One-liner role description** below the name (the agent's role/purpose, could come from first line of system prompt or a dedicated field)
- **Latest activity line** showing what the agent is doing or last did:
  - Working: `Working on 6 pistachio tasks · 4m` (from current session detail + duration)
  - Completed: `Processed 4 insights · 25m ago` (from last session)
  - Failed: `✕ API rate limit exceeded · 22m ago` (from last failed session, in red)
- Card border/background tint:
  - Working: subtle accent tint with accent border
  - Failed: subtle red border
  - Idle: default border

## Key Files to Modify
- `apps/web/src/routes/_authed/$workspaceId/agents.tsx` — add filter tabs
- `apps/web/src/components/agents/` — update agent card component
- `apps/web/src/hooks/` — may need to extend agent query to include latest session info

## Data Requirements
- Need latest session per agent (status, detail/summary, time, duration)
- The current app derives activity from events in last 5 minutes — may want to also query sessions directly for richer info
- Agent role/description could be:
  - A new `description` field on the actor
  - Or parsed from the first line of the system prompt

## Notes
- The grid layout can stay as-is, just with richer card content
- Consider switching from grid to a list layout (like the prototype) for the richer cards — the extra text may not fit well in a grid
