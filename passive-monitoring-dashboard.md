# Bridge — A Second-Screen Dashboard for Maskin

## Context

Maskin's premise is that product managers shouldn't have to live inside a task tracker or read code daily. But they still need a "home" — a screen that can sit on a second monitor while they work (or watch a movie) and let them feel like the *captain of an AI team*, not the *operator of a task system*.

Today, the workspace landing page is `apps/web/src/routes/_authed/$workspaceId/index.tsx` — a two-tab "Pulse" with `WhatsHappening` (Overview) and `Notifications`. It's already quite good for active engagement, but it's not designed to be **glanceable from across the room** or to give a calm, narrative sense of the AI team working in the background. The paperclip inspiration is competent SaaS dashboard work (stat cards + bar charts + recent activity), but it's operator-flavored — it doesn't dramatize the agents working *for* you.

We are replacing Pulse with a new landing experience that fuses the two: enough operator metrics to feel in control, but anchored by a cinematic, narrative core that feels alive. The decision was: **replace Pulse as the landing page**, **lightweight CSS/SVG charts** (no new dependencies), **no audio cues** (visual-only, can add later).

## Design Philosophy

- **Glanceable.** Big type, generous whitespace. State should be readable from 6+ feet away.
- **Cinematic over operational.** One thing happening at a time, not a wall of dashboards. Slideshow / heartbeat instead of dense tables.
- **Anxiety-free baseline.** Empty / idle states are calm, not alarming. Red is reserved for things that actually need a human.
- **Action without focus.** Approvals are big enough to hit with a casual click; defaults are sensible so a single keystroke can dispatch a decision.
- **Narrative > log.** Where Activity shows raw events, Bridge shows sentences a human reads ("Sarah is reviewing analytics for FOO-4").
- **Reuse aggressively.** Almost every primitive already exists. New components are compositional only.

## Layout (top → bottom, single scroll)

1. **Headline strip** — workspace name, live SSE pulse dot, one-sentence narrative summary of today, ambient ticker (`3 agents working · 1 task in progress · 2 decisions waiting`). Keep `SindrePulseBar` underneath so users can still talk to the system.
2. **Now Happening (hero)** — large cinematic card showing the single most-active session: agent avatar (large), issue title, latest log line as a typewriter ribbon, elapsed timer. If multiple sessions are live, auto-rotate every ~8s with dot indicators. If nothing is running, show the next scheduled trigger or a calm "Team at rest" message.
3. **Decisions Needed** — pending notifications elevated to first-class blocks. Reuses the existing `PulseCard` rendering but in a roomier 1-up layout with bigger action targets. Hidden when empty.
4. **The Team (roster)** — grid of every agent as a compact card with avatar, current status ring (working/idle/waiting/failed), latest action snippet, last-active time. Click → agent detail.
5. **Pipeline** — minimal 3-column flow (`Proposed → In Progress → Done`) for bets/tasks. Reuses the counts already computed inside `WhatsHappening`.
6. **Live Feed (captions)** — humanized auto-scrolling stream of events. Big text, slow scroll, pause-on-hover. Different from Activity (which is a forensic log) — this is a story.
7. **Vitals** — paperclip-inspired bottom strip: 3 stat cards (Agents Working, Tasks In Progress, Decisions Pending) and 4 mini bar charts (Run Activity, Issues by Priority, Issues by Status, Success Rate) over the last 14 days. CSS/SVG only. **Spend is intentionally omitted** — there is no cost-tracking backend yet, and a `$0` placeholder would just create noise.

## Files to Modify

- `apps/web/src/routes/_authed/$workspaceId/index.tsx` — **replace** the existing `PulseDashboard` two-tab UI with the new composition. Keep `SindrePulseBar` at the top.
- `apps/dev/src/routes/workspaces.ts` (or new `apps/dev/src/routes/dashboard.ts` registered in `apps/dev/src/index.ts`) — add the `GET /api/workspaces/:id/headline` route described under "Narrative Headline".
- `packages/shared/src/schemas/` — add `dashboard.ts` with the request/response schemas for the headline endpoint, exported from the schemas barrel.
- `apps/web/src/lib/api.ts` — add the typed `api.workspaces.headline(id)` (or `api.dashboard.headline(workspaceId)`) client method that the new hook calls.

## Files to Create (all under `apps/web/src/components/dashboard/`)

- `dashboard-headline.tsx` — top strip: SSE status dot (`useSSE`), one-line narrative (see "Narrative headline" below), ambient ticker derived from sessions/notifications.
- `use-dashboard-headline.ts` (in `apps/web/src/hooks/`) — fetches the LLM-generated narrative from the new backend endpoint with TanStack Query (5-minute `staleTime`); on error / loading falls back synchronously to the rule-based summary.
- `narrative-fallback.ts` (next to the hook) — pure function `(events, actors, objects) → string` that produces a sensible English sentence from today's aggregates. Used both as the loading placeholder and the error fallback.
- `now-happening-hero.tsx` — pulls `useWorkspaceSessions(status='running')`, picks the most recent, fetches `useSessionLatestLog` for the typewriter line, rotates between sessions every 8s. Uses `useDuration` for the elapsed timer. Reuses `ActorAvatar`, `StreamingIndicator`. Empty state uses `useTriggers` to surface "next scheduled run".
- `decisions-panel.tsx` — wraps existing `PulseCard` (`apps/web/src/components/pulse/pulse-card.tsx`) in a wider single-column layout. Fed by `useNotifications(workspaceId, { status: 'pending,seen' })`. Uses existing `useUpdateNotification` / `useRespondNotification`.
- `team-roster.tsx` — grid of `AgentCard`-style tiles for every actor. Reuses `AgentCard` (`apps/web/src/components/agents/agent-card.tsx`) at a smaller size, or composes from `ActorAvatar` + status ring derived via `apps/web/src/lib/agent-status.ts`.
- `pipeline-flow.tsx` — three-column visual; counts derived the same way as `WhatsHappening` (`apps/web/src/components/overview/whats-happening.tsx`). Extract just the flow logic, not the rest of WhatsHappening.
- `live-feed-captions.tsx` — `useEvents(workspaceId, { limit: '50' })` → humanizing formatter that maps `(actor, action, entity_type, entity_title)` → English sentence. Auto-scrolls; uses `RelativeTime`. Reuses virtualization from `apps/web/src/components/activity/activity-feed.tsx` only if list grows large.
- `event-humanizer.ts` — pure function converting `EventResponse` rows + actor/object lookups into one-sentence captions ("Head of Product is investigating FOO-4 — competitive landscape"). Lives next to `live-feed-captions.tsx`.
- `vitals-strip.tsx` — composes 3 stat cards + 4 `mini-bar-chart` instances. Counts come from existing hooks. No spend card.
- `mini-bar-chart.tsx` — pure CSS/SVG component, props: `data: { label: string, value: number, color?: string }[]`, `height`, optional stacked groups (for Issues by Status). 30–40 LOC, no library.

## Reused Building Blocks (do not rebuild)

- `useSSE`, `useNotifications`, `useActors`, `useWorkspaceSessions`, `useSessionLatestLog`, `useEvents`, `useObjects`, `useBets`, `useTriggers`, `useDuration`
- `PulseCard`, `AgentCard`, `SindrePulseBar`
- `ActorAvatar`, `StreamingIndicator`, `AgentWorkingBadge`, `RelativeTime`, `EmptyState`, `StatusBadge`, `MarkdownContent`
- `Card`, `Badge`, `Button`, `Tabs`, `Tooltip` from `apps/web/src/components/ui/`
- Status derivation in `apps/web/src/lib/agent-status.ts`
- Pipeline counts logic from `apps/web/src/components/overview/whats-happening.tsx`

## Narrative Headline (LLM with rule-based fallback)

The headline is one short sentence describing today's state of the team. Two layers:

1. **Primary (LLM).** New backend endpoint `GET /api/workspaces/:id/headline` in `apps/dev/src/routes/workspaces.ts` (or a new `apps/dev/src/routes/dashboard.ts` mounted under `/api/dashboard`):
   - Aggregates last 24h of events, in-progress sessions, and pending notifications inside the route handler.
   - Calls the workspace's configured LLM via the existing client used by Sindre / agent execution (locate the shared LLM call helper before implementing — likely under `apps/dev/src/services/` or `apps/dev/src/lib/llm/`; reuse it, do not add a new SDK).
   - System prompt constrains the model to a single sentence, present tense, no markdown, ≤140 chars.
   - Response shape: `{ headline: string, generatedAt: string, source: 'llm' | 'fallback' }`.
   - 5-minute server-side cache keyed by workspace + 5-min bucket, so a second-screen refresh isn't expensive.
   - Validate input/output with Zod schemas added to `packages/shared/src/schemas/dashboard.ts` per `.claude/rules/input-validation.md`.
2. **Fallback (rule-based).** When the LLM call fails, times out (>3s), or no LLM is configured, the endpoint returns a deterministically generated sentence built by `narrative-fallback.ts` (e.g., "Your team is investigating 2 issues and has shipped 1 today."). Same `source: 'fallback'` flag.
3. **Frontend.** `use-dashboard-headline.ts` fetches the endpoint with a 5-minute `staleTime`. While loading or on network failure, the component renders the local rule-based fallback so the headline is *always* present — never a spinner, never blank.

## Things Explicitly Not Doing

- No new charting dependency (per decision).
- No audio cues (per decision).
- No spend / cost UI (per decision — backend doesn't track it yet).
- No replacement of the Activity page or removal of `WhatsHappening` (the latter can stay where it is or be deleted if nothing else imports it; verify before deleting).
- No login/session work — landing route stays inside the existing `_authed/$workspaceId` shell.

## Open Questions / Caveats

- **LLM client location.** Confirm during implementation which existing helper is the right reuse target for the headline endpoint. Do not introduce a new Anthropic/OpenAI SDK if Sindre or the session manager already wraps one.
- **WhatsHappening fate.** Once its content is folded into the new dashboard sections, decide whether to delete `whats-happening.tsx` or leave it for reuse. Plan defaults to leaving it untouched until usages confirm it's orphaned.

## Verification

End-to-end:
1. `pnpm dev` (or `pnpm dev:win`), wait for the `🚀 Maskin is running` banner, run `claude mcp add` line from the banner output, `/reload-plugins`.
2. Open `http://localhost:5173/<workspaceId>/` — confirm the new dashboard renders all sections (headline, hero, decisions, team, pipeline, feed, vitals).
3. Trigger a session via the MCP `get_started` flow or by creating a bet that fires an agent. Watch:
   - Hero rotates to the live session, typewriter ribbon updates from log stream.
   - Live Feed prepends a new caption.
   - Vitals "Agents Working" increments.
4. Approve/respond to a notification from the Decisions panel — confirm it disappears via SSE invalidation without a manual refresh.
5. Disconnect network briefly — confirm SSE dot goes amber/red and the offline banner appears (existing behavior via `useOnlineStatus`).
6. Resize the window to a wide aspect (≥1920px); confirm layout is comfortable for second-screen viewing.

Tests:
- `cd apps/web && pnpm vitest run` — add unit tests for `event-humanizer.ts`, `narrative-fallback.ts` (deterministic sentence for given inputs), and `mini-bar-chart.tsx` (renders correct bar heights/labels). Follow patterns in `apps/web/src/__tests__/`.
- `cd apps/dev && pnpm vitest run` — add a route test for the new headline endpoint covering: happy LLM path (mock the LLM helper), fallback path when the helper throws, and Zod validation rejection. Patterns in `apps/dev/src/__tests__/routes/`.
- `pnpm lint`, `pnpm type-check`, `pnpm test -- --run` per `.claude/rules/pre-commit.md`.

Manual visual QA:
- Empty states for every panel (fresh workspace with no agents/sessions/notifications).
- Loaded states with multiple sessions running simultaneously (hero rotation).
- Failed-session state (red ring on agent card; calm but visible).
