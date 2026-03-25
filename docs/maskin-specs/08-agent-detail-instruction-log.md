# Agent Detail: Instruction Log (One-off Agent Chat)

## Summary
Add a chat-style instruction interface on the agent detail page where users can send a quick one-off message to an agent and see the result inline.

## Current Behavior
To instruct an agent, users must create a session via the API/MCP with an action prompt, or set up a trigger. The agent detail page is purely configuration (system prompt, LLM, MCP servers, skills, memory). There is no way to quickly send an instruction and see the result.

## Desired Behavior

### Instruction log section
- Positioned prominently on the agent detail page, above the configuration
- Contains a scrollable log of instruction exchanges and an input field

### Input
- Text input: `"Tell [Agent Name] what to do..."`
- Send button
- Enter to submit

### Conversation flow
When the user sends a message:
1. **User message** appears in the log (right-aligned or with user avatar)
2. **Acknowledgment** from agent appears with a spinner: "Got it. Working on it..."
   - This represents the session being created and starting
3. **Response** replaces/follows the acknowledgment when the session completes
   - Shows the agent's output/result
   - If the agent took actions (created objects, updated things), show them as a list:
     ```
     ✓ Updated task: Launch cheese box ads
     ✓ Paused Facebook ad set
     ✓ Created Instagram ad set
     ```
4. Optionally, the result surfaces as a new item on the Pulse page

### Message styling
- User messages: blue-tinted background
- Agent acknowledgments: gray background with spinner
- Agent responses: accent-tinted background with action list

## Implementation

### Under the hood
Each user message triggers:
1. `create_session` with `action_prompt` = the user's message, `actor_id` = this agent
2. Poll or SSE-stream the session status
3. When session reaches `completed` or `failed`, show the result
4. Parse session logs for the agent's output and any actions taken

### Log persistence
- The instruction log should persist across page navigation within the same browser session (at minimum)
- Consider storing instruction exchanges as events or in a dedicated table for true persistence
- Or treat them as ephemeral — each page visit starts with an empty log (simpler)

## Key Files to Modify
- `apps/web/src/components/agents/agent-document.tsx` — add instruction log section
- New component: `InstructionLog` with message list + input
- `apps/web/src/hooks/` — hook for creating sessions and streaming/polling results
- Existing session creation and log streaming endpoints can be reused

## Data Requirements
- Reuses existing session infrastructure entirely
- The instruction = `action_prompt`
- The response = parsed session logs (stdout stream)
- Actions taken = could be derived from events created during the session

## Notes
- This is the biggest UX improvement for agent interaction — it makes agents feel like conversational teammates
- The prototype simulated this with canned responses, but the real implementation would use actual session execution
- Consider a loading timeout and error handling (what if session fails or takes too long)
- The instruction log should scroll to bottom on new messages
