# Agent Detail: Collapsible Configuration

## Summary
Move the technical configuration (system prompt, LLM, MCP servers, skills, memory, API key) into a collapsible "Configuration" section, collapsed by default. Prioritize showing the agent's identity, status, and what it's working on.

## Current Behavior
The agent detail page leads with configuration fields: system prompt textarea, LLM provider/model, MCP servers, skills, memory, API key. The activity log is at the bottom. The page is optimized for setup, not for ongoing use.

## Desired Behavior

### Above the fold (always visible)
1. Agent name (editable)
2. Status line: `agent · working 🔄` or `agent · idle` + memory size
3. Instruction log (see spec 08)
4. Objects linked to this agent (optional, nice-to-have)
5. Sessions list — recent sessions with status, description, time, duration

### Configuration section (collapsed by default)
- Toggle button: `▸ Configuration` / `▾ Configuration`
- When expanded, shows:
  - **System Prompt** — textarea
  - **LLM** — provider select + model input, side by side
  - **MCP Servers** — list of connected servers with add/edit/delete
  - **Skills** — skill cards with add/edit/delete
  - **Memory** — JSON editor
  - **API Key** — with regenerate button

### Sessions section
- Show recent sessions above the configuration toggle
- Each session row: status indicator (spinner/green dot/red dot), description, duration, time
- Failed sessions have an expandable error detail and a Retry button

## Key Files to Modify
- `apps/web/src/components/agents/agent-document.tsx` — restructure the layout
- The individual config sections (MCP, skills, memory, etc.) stay as-is internally, just wrapped in the collapsible container

## Notes
- This is primarily a layout reorganization, not new functionality
- The key insight: users configure agents once but interact with them daily — the page should reflect that priority
- Use a simple state toggle for the collapsed/expanded state; could persist to localStorage
