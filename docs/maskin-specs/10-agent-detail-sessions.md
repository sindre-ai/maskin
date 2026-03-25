# Agent Detail: Improved Sessions Section

## Summary
Show richer session information on the agent detail page — what the agent worked on in each session, not just status and time.

## Current Behavior
Session information is available but the agent detail page primarily shows configuration. Session logs are accessible via separate API endpoints.

## Desired Behavior

### Sessions list on agent detail
- Section header: `Sessions`
- List of recent sessions, each showing:
  - **Status indicator**: spinner (running), green dot (completed), red dot (failed)
  - **Description**: what the agent did — e.g. "Working on 6 pistachio tasks", "Day 11 update for lactose-free"
  - **Duration**: how long the session ran (e.g. "45s", "4m")
  - **Time**: when it ran (e.g. "25m ago", "1h ago")
- Running sessions show the spinner and live duration

### Failed sessions
- Show description in red
- Expandable error detail (toggle button: "Error" / "Hide")
- "Retry" button that creates a new session with the same action prompt

### Descriptive summaries
- The session description should come from the `action_prompt` or be derived from session logs
- For currently running sessions, show the action prompt as the description
- For completed sessions, ideally show a summary of what was accomplished

## Key Files to Modify
- `apps/web/src/components/agents/agent-document.tsx` — add/improve sessions section
- `apps/web/src/hooks/` — query sessions filtered by agent ID, ordered by recency

## Data Requirements
- `list_sessions` filtered by `actor_id` with recent-first ordering
- Session `action_prompt` as the primary description source
- Session logs for error details on failed sessions

## Notes
- This ties into the broader theme of showing "what's happening" throughout the app
- The same session info that appears here should be consistent with what's shown on objects (spec 02) and the agents list (spec 07)
