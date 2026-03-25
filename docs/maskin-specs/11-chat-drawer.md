# Chat Drawer (Right-Side Assistant)

## Summary
Add a persistent right-side chat drawer where users can have a conversation with an LLM that has full workspace context via the AI-native MCP. By default it's a plain Claude conversation; users can switch to a specific agent via slash commands.

## Current Behavior
There is no chat/assistant UI in the app.

## Desired Behavior

### Drawer basics
- Right-side panel (roughly 380px wide) that pushes main content left when open
- Toggle button in the top bar: `[Sindre logo] Ask`
- Close button (×) in the drawer header
- Persists across page navigation (stays open as user navigates)

### Default mode: plain LLM
- By default, the chat is a conversation with Claude (Anthropic)
- The LLM is given:
  - The AI-native MCP connection (so it can read/write workspace data)
  - The current page URL / context (so it knows what the user is looking at)
- If the user doesn't have Anthropic configured, fall back to OpenAI
- The conversation runs in a container session, same as agent sessions

### Slash commands
- Typing `/` opens an autocomplete menu with commands:
  - `/agent` — select a specific agent to talk to (opens agent picker)
  - `/object` — reference an object (opens object picker, attaches as context chip)
  - `/create` — create a new object (insight/bet/task picker)
  - `/status` — quick status overview of active work
- Arrow keys to navigate, Enter/Tab to select, Escape to dismiss

### `/agent` — talk to a specific agent
- After selecting an agent, the conversation switches to that agent
- The agent's system prompt, LLM config, and MCP servers are used
- The current page URL is still provided as context
- A visual indicator shows which agent the user is talking to
- **Cannot switch agents mid-conversation** — user must start a new conversation
- "New conversation" button to reset

### Attached references
- When using `/agent` or `/object`, selected items appear as chips above the input
- Chips can be removed with ×
- References are included as context when the message is sent
- Backspace on empty input removes the last chip

### Message rendering
- User messages: accent/dark background, right-aligned feel
- Assistant messages: gray background, left-aligned
- Support **bold** text (markdown bold)
- Object reference chips on assistant replies — clickable, navigate to object detail and close drawer

### Typing indicator
- Show animated dots while waiting for a response

### Page awareness
- The drawer should always know which page/object/agent the user is currently viewing
- This context is passed to the LLM so it can give relevant answers
- Example: if the user is on a bet detail page and asks "what's going wrong?", the LLM should know which bet

### Footer
- `Connected to workspace via Maskin MCP` (or similar connection status)

## Implementation

### Container-based execution
- Each chat conversation = a session running in a Docker container
- Default: uses a generic actor with Claude + AI-native MCP
- With `/agent`: uses the selected agent's configuration
- Messages sent by the user become instructions appended to the session
- Agent responses are streamed back via session log SSE

### Session management
- Opening the drawer or starting a new conversation creates a new session
- The session stays alive while the drawer is open
- "New conversation" creates a fresh session
- Closing the drawer could either keep the session alive (for reopening) or terminate it

### MCP access
- The session always has the AI-native MCP configured
- This gives the LLM full workspace access (read/write objects, agents, relationships, etc.)
- When using a specific agent, that agent's additional MCP servers are also available

## Key Files to Modify
- New component: `apps/web/src/components/layout/chat-drawer.tsx`
- New component: `apps/web/src/components/layout/slash-menu.tsx`
- `apps/web/src/components/layout/` — main layout to include the drawer
- `apps/web/src/hooks/` — hooks for session creation, log streaming, agent/object search for slash menus
- Top bar component — add the "Ask" toggle button

## Data Requirements
- Session creation and log streaming (existing infrastructure)
- Agent list for `/agent` picker
- Object search for `/object` picker
- Current route/page info for context passing

## Design Decisions
- Should conversations persist across browser sessions? (stored in DB vs ephemeral)
- Max conversation length before suggesting a new conversation?
- How to handle slow/failed responses?
- Should the drawer be resizable?
- Mobile behavior — full-screen overlay instead of side panel?

## Notes
- This is the most complex new feature — it combines session management, real-time streaming, slash command UI, and context-aware LLM interaction
- Start with the basic plain-LLM mode first, then add agent switching and slash commands
- The slash command pattern is similar to the existing command palette — consider reusing that infrastructure
