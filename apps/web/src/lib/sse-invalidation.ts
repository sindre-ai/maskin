import type { InvalidateQueryFilters, QueryClient } from '@tanstack/react-query'
import { trackAgentSessionCompleted, trackTriggerFired } from './analytics'
import { api } from './api'
import { queryKeys } from './query-keys'
import type { SSEEvent } from './sse'

const SESSION_COMPLETION_ACTIONS = new Map<string, 'completed' | 'failed' | 'timeout'>([
	['session_completed', 'completed'],
	['session_failed', 'failed'],
	['session_timeout', 'timeout'],
])

// Session events that can move the credit balance or end a run. Billing usage
// only needs a refetch on these; routine session_updated / session_started
// traffic does not change it.
const BILLING_INVALIDATING_ACTIONS = new Set(['session_credit_debited', 'session_budget_stopped'])

// Trailing windows for the refetches a burst of session events would otherwise
// multiply. Agents PATCH current_activity on every step and a scheduled trigger
// can finish dozens of runs at once, so one busy minute emits a burst of
// session events; each target refetches once per window instead of per event.
//
// The workspace sessions list (?limit=100) drives the sidebar's live activity
// text, so it keeps a short window. Billing usage only moves on terminal and
// credit events and is the most expensive read in the app, so it gets a longer
// one. The server evicts its usage cache when it records those events
// (lib/events/record-event.ts), so a refetch is never answered from a snapshot
// older than the event no matter how long the window is.
const SESSIONS_REFETCH_MS = 5_000
const BILLING_REFETCH_MS = 15_000
const trailingRefetchTimers = new Map<string, ReturnType<typeof setTimeout>>()

const isTabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

// Query clients that have deferred invalidations waiting for their tab to
// come back, and the ones we have already attached a visibility listener to.
const dirtyWhileHidden = new WeakSet<QueryClient>()
const listening = new WeakSet<QueryClient>()

// A background tab has nobody looking at it, but invalidating an active query
// refetches it right away — with several tabs open that multiplies every SSE
// event by the tab count. While hidden, only mark queries stale (no refetch)
// and catch up once, on the invalidated ones that are still on screen, when
// the tab becomes visible again.
function invalidate(
	queryClient: QueryClient,
	filters: InvalidateQueryFilters,
	options?: { cancelRefetch?: boolean },
) {
	if (!isTabHidden()) {
		return options
			? queryClient.invalidateQueries(filters, options)
			: queryClient.invalidateQueries(filters)
	}
	dirtyWhileHidden.add(queryClient)
	if (!listening.has(queryClient)) {
		listening.add(queryClient)
		document.addEventListener('visibilitychange', () => {
			if (isTabHidden() || !dirtyWhileHidden.has(queryClient)) return
			dirtyWhileHidden.delete(queryClient)
			void queryClient.refetchQueries({
				type: 'active',
				predicate: (query) => query.state.isInvalidated,
			})
		})
	}
	return queryClient.invalidateQueries({ ...filters, refetchType: 'none' }, options)
}

function scheduleTrailingRefetch(
	queryClient: QueryClient,
	timerKey: string,
	filters: InvalidateQueryFilters,
	delayMs: number,
) {
	if (trailingRefetchTimers.has(timerKey)) return
	trailingRefetchTimers.set(
		timerKey,
		setTimeout(() => {
			trailingRefetchTimers.delete(timerKey)
			// cancelRefetch: false joins a fetch that is already in flight instead
			// of cancelling it and starting another (the cancelled request still
			// reaches the server). An event that lands mid-fetch re-arms the timer,
			// so it is never lost.
			invalidate(queryClient, filters, { cancelRefetch: false })
		}, delayMs),
	)
}

export function invalidateFromSSE(queryClient: QueryClient, workspaceId: string, event: SSEEvent) {
	// `session.state_changed` frames (bet/444b-handed-off-strip) carry a
	// `SessionStateChangedPayload` — not the generic `events` row shape — so
	// `entity_type`/`entity_id` are absent and the switch below never matches
	// them. They pair a sub-session's live status with the delegation strip
	// rendered on `spawned_sessions`, which is embedded in the messages list
	// response. Invalidate every conversation-messages query in this workspace
	// so any open thread carrying the affected sub-session refetches; rows
	// never reorder in the strip so the refetch is invisible unless the pill
	// itself changed.
	if (event.action === 'session.state_changed') {
		// Every open conversation-messages query in this tab: the SSE payload
		// carries `session_id`, not the owning conversation id, so a narrower
		// invalidation would have to walk cached pages to find the strip that
		// owns the sub-session. The prefix here matches `queryKeys.conversations`
		// so a future refactor of the key shape keeps the invalidation in step.
		invalidate(queryClient, { queryKey: ['conversations', 'detail'] })
		return
	}

	// Always invalidate events history
	invalidate(queryClient, { queryKey: queryKeys.events.history(workspaceId) })
	invalidate(queryClient, { queryKey: queryKeys.events.byEntity(event.entity_id) })

	// Live-refresh the knowledge doc-header reference-count chip. The DoD
	// tolerates a 5-minute lag (matches the hook's staleTime), but when a
	// fresh cite lands over SSE we already know a downstream agent read this
	// object — invalidate the counter so the chip catches up in the same tick.
	if (event.action === 'workspace_knowledge_referenced') {
		invalidate(queryClient, { queryKey: queryKeys.objects.references(event.entity_id) })
	}

	// New comments may change unread counts for any subscriber in this workspace
	// and the subscriber list for the entity that was commented on (the latter
	// because the commenter auto-subscribes server-side).
	if (event.action === 'commented') {
		invalidate(queryClient, {
			queryKey: ['subscriptions', 'unread', workspaceId],
		})
		invalidate(queryClient, {
			queryKey: queryKeys.subscriptions.subscribers(event.entity_type, event.entity_id),
		})
		// Also refresh the detail/graph so unread_count + subscriber_count update.
		invalidate(queryClient, { queryKey: queryKeys.objects.detail(event.entity_id) })
		invalidate(queryClient, { queryKey: queryKeys.objects.graph(event.entity_id) })
	}

	// Invalidate based on entity type
	switch (event.entity_type) {
		case 'insight':
		case 'bet':
		case 'task':
		case 'loop':
		case 'knowledge':
			invalidate(queryClient, { queryKey: queryKeys.objects.all(workspaceId) })
			invalidate(queryClient, { queryKey: queryKeys.objects.detail(event.entity_id) })
			invalidate(queryClient, { queryKey: queryKeys.objects.graph(event.entity_id) })
			if (event.entity_type === 'bet') {
				invalidate(queryClient, { queryKey: queryKeys.bets.all(workspaceId) })
			}
			if (event.entity_type === 'loop') {
				invalidate(queryClient, { queryKey: queryKeys.loops.all(workspaceId) })
			}
			break
		case 'relationship':
			invalidate(queryClient, { queryKey: queryKeys.relationships.all(workspaceId) })
			invalidate(queryClient, { queryKey: ['objects', 'graph'] })
			break
		case 'trigger':
			invalidate(queryClient, { queryKey: queryKeys.triggers.all(workspaceId) })
			if (event.action === 'trigger_fired') {
				// Loop-detail "Latest activity" is a join through metadata.trigger_ids
				// keyed to the trigger — we don't know which loop from the payload,
				// so invalidate every open loop-activity query in this workspace.
				invalidate(queryClient, { queryKey: ['loops', workspaceId, 'activity'] })
				trackTriggerFired({
					entity_id: event.entity_id,
					entity_type: 'trigger',
					flow_id: event.event_id ?? null,
				})
			}
			break
		case 'session': {
			// Broad prefix invalidation covers all session queries including byActor,
			// detail and logs — except the workspace list (exactly ['sessions', ws]),
			// which is coalesced below. The prefix also matches it, so exclude it here.
			invalidate(queryClient, {
				queryKey: ['sessions'],
				predicate: (query) => {
					const key = query.queryKey
					return !(key.length === 2 && key[1] === workspaceId)
				},
			})
			scheduleTrailingRefetch(
				queryClient,
				`sessions:${workspaceId}`,
				{
					queryKey: queryKeys.sessions.all(workspaceId),
					exact: true,
				},
				SESSIONS_REFETCH_MS,
			)
			// Same reasoning as trigger_fired above — session lifecycle events feed
			// into the loop activity view via the trigger id join.
			invalidate(queryClient, { queryKey: ['loops', workspaceId, 'activity'] })
			// Sessions burn credits and can flip the workspace into PAUSED · NO
			// CREDITS mid-flight. The D6 chip reads through `useUsageState` →
			// `useBillingUsage`; only credit debits, budget stops and terminal
			// events can change that, so routine session updates skip the refetch
			// and the rest coalesce into one refetch per window.
			const outcome = SESSION_COMPLETION_ACTIONS.get(event.action)
			if (outcome || BILLING_INVALIDATING_ACTIONS.has(event.action)) {
				scheduleTrailingRefetch(
					queryClient,
					`billing:${workspaceId}`,
					{
						queryKey: queryKeys.billing.usage(workspaceId),
					},
					BILLING_REFETCH_MS,
				)
			}
			if (outcome) {
				const sessionId = event.entity_id
				// G2 trigger provenance lives on the session row — the `trigger_id`
				// column plus the `trigger_type` folded into `config` by
				// `createSession` — and the SSE payload has carried no `data` since
				// migration 0006 dropped it for the 8KB NOTIFY limit. So read the row
				// back. Fire-and-forget: `onEvent` is not awaited upstream
				// (`sse.ts`), so this cannot stall the stream, and a completion whose
				// row is unreadable (deleted, evicted) still emits — just without
				// provenance, rather than being dropped.
				void (async () => {
					let triggerId: string | null = null
					let triggerType: string | null = null
					try {
						const session = await api.sessions.get(sessionId, workspaceId)
						triggerId = session.triggerId
						triggerType =
							typeof session.config?.trigger_type === 'string' ? session.config.trigger_type : null
					} catch {
						// Provenance is best-effort; the completion itself is not.
					}
					trackAgentSessionCompleted({
						entity_id: sessionId,
						entity_type: 'session',
						outcome,
						flow_id: event.event_id ?? null,
						trigger_id: triggerId,
						trigger_type: triggerType,
					})
				})()
			}
			break
		}
		case 'notification':
			invalidate(queryClient, { queryKey: queryKeys.notifications.all(workspaceId) })
			break
		case 'actor':
			invalidate(queryClient, { queryKey: queryKeys.actors.all(workspaceId) })
			break
		case 'workspace':
			invalidate(queryClient, { queryKey: queryKeys.workspaces.all() })
			break
		case 'workspace_skill':
			// all() is a prefix of detail() so this covers both list and detail queries
			invalidate(queryClient, { queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			break
		case 'agent_skill':
			// The event's entity_id is the workspace-skill id; the target actorId is not in the
			// SSE payload, so invalidate all attachment queries in this tab with a broad prefix.
			invalidate(queryClient, { queryKey: ['agent-skill-attachments'] })
			break
		case 'file':
			// all() is a prefix of detail() so this covers both list and detail queries.
			invalidate(queryClient, { queryKey: queryKeys.files.all(workspaceId) })
			break
		case 'conversation':
			// Message posts also carry entity_type 'conversation' (entity_id is the
			// conversation, not the message) — detail(id) is a prefix of
			// messages(id, ...) so this one invalidation covers the thread's
			// detail, participants, and message pages too.
			invalidate(queryClient, { queryKey: queryKeys.conversations.all(workspaceId) })
			invalidate(queryClient, { queryKey: queryKeys.conversations.detail(event.entity_id) })
			break
	}
}
