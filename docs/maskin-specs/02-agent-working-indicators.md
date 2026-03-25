# Agent Working Indicators Across the App

## Summary
Show which agent is currently working on an object and what it's doing, everywhere objects appear — objects list, object detail, and agent detail page.

## Current Behavior
Objects have an `activeSessionId` field. The UI shows a simple active/idle badge on agents. There is no inline indication on object rows of what an agent is doing or its progress.

## Desired Behavior

### Objects page (list rows)
- If an object has an active session, show a spinner + agent name + progress summary below the object title
- Example: `🔄 Bet Shepherd · Generating logo concepts. 3/5 done.`

### Object detail page
- Show a prominent banner below the title when an agent is working on this object
- Banner includes: spinner, agent name, current progress text, duration
- Example: `🔄 Bet Shepherd — Setting up Next.js · 2m`

### Agent detail page
- On the objects list within agent detail, show the same spinner + progress for objects this agent is actively working on

## Data Requirements
- Need to associate active sessions with specific objects — the session likely has context about which object(s) it's operating on
- Need a way to get a human-readable progress summary from the running session
- Options:
  1. Session logs — parse latest log entry for a summary
  2. Session metadata — agent writes progress to a field during execution
  3. Object metadata — agent updates the object's metadata with progress info via MCP

## Key Files to Modify
- `apps/web/src/components/objects/` — object list item component, add working indicator
- `apps/web/src/routes/_authed/$workspaceId/objects/$objectId.tsx` — object detail, add banner
- `apps/web/src/components/agents/agent-document.tsx` — agent detail objects section
- `apps/web/src/components/shared/` — create a reusable `AgentWorkingBadge` component (one may already exist)

## Design Decisions Needed
- How does the agent communicate progress? (session logs vs metadata update vs dedicated field)
- How frequently should the UI poll for progress updates? (SSE already exists for events — could extend)
- What happens when the agent finishes? (indicator disappears, replaced by completion event in activity)

## Notes
- This connects to the existing SSE real-time infrastructure — progress updates could be streamed
- The prototype used `agentWorking`, `agentProgress`, `agentName`, `agentDuration` fields directly on objects — in the real app this would likely come from joining session data
